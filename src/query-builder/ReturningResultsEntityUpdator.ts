import { ObjectLiteral } from "../common/ObjectLiteral"
import { QueryRunner } from "../query-runner/QueryRunner"
import { QueryExpressionMap } from "./QueryExpressionMap"
import { ColumnMetadata } from "../metadata/ColumnMetadata"
import { UpdateResult } from "./result/UpdateResult"
import { InsertResult } from "./result/InsertResult"
import { TypeORMError } from "../error"

/**
 * Updates entity with returning results in the entity insert and update operations.
 */
export class ReturningResultsEntityUpdator {
    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(
        protected queryRunner: QueryRunner,
        protected expressionMap: QueryExpressionMap,
    ) {}

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Updates entities with a special columns after updation query execution.
     */
    async update(
        updateResult: UpdateResult,
        entities: ObjectLiteral[],
    ): Promise<void> {
        const metadata = this.expressionMap.mainAlias!.metadata

        await Promise.all(
            entities.map(async (entity, entityIndex) => {
                // if database supports returning/output statement then we already should have updating values in the raw data returned by insert query
                if (
                    this.queryRunner.connection.driver.isReturningSqlSupported(
                        "update",
                    )
                ) {
                    if (
                        this.queryRunner.connection.driver.options.type ===
                            "oracle" &&
                        Array.isArray(updateResult.raw) &&
                        this.expressionMap.extraReturningColumns.length > 0
                    ) {
                        updateResult.raw = updateResult.raw.reduce(
                            (newRaw, rawItem, rawItemIndex) => {
                                newRaw[
                                    this.expressionMap.extraReturningColumns[
                                        rawItemIndex
                                    ].databaseName
                                ] = rawItem[0]
                                return newRaw
                            },
                            {} as ObjectLiteral,
                        )
                    }
                    const result = Array.isArray(updateResult.raw)
                        ? updateResult.raw[entityIndex]
                        : updateResult.raw
                    const returningColumns =
                        this.queryRunner.connection.driver.createGeneratedMap(
                            metadata,
                            result,
                        )
                    if (returningColumns) {
                        this.queryRunner.manager.merge(
                            metadata.target as any,
                            entity,
                            returningColumns,
                        )
                        updateResult.generatedMaps.push(returningColumns)
                    }
                } else {
                    // for driver which do not support returning/output statement we need to perform separate query and load what we need
                    const updationColumns =
                        this.expressionMap.extraReturningColumns
                    if (updationColumns.length > 0) {
                        // get entity id by which we will get needed data
                        const entityId =
                            this.expressionMap.mainAlias!.metadata.getEntityIdMap(
                                entity,
                            )
                        if (!entityId)
                            throw new TypeORMError(
                                `Cannot update entity because entity id is not set in the entity.`,
                            )

                        // execute query to get needed data
                        const loadedReturningColumns =
                            (await this.queryRunner.manager
                                .createQueryBuilder()
                                .select(
                                    metadata.primaryColumns.map(
                                        (column) =>
                                            metadata.targetName +
                                            "." +
                                            column.propertyPath,
                                    ),
                                )
                                .addSelect(
                                    updationColumns.map(
                                        (column) =>
                                            metadata.targetName +
                                            "." +
                                            column.propertyPath,
                                    ),
                                )
                                .from(metadata.target, metadata.targetName)
                                .where(entityId)
                                .withDeleted()
                                .setOption("create-pojo") // use POJO because created object can contain default values, e.g. property = null and those properties might be overridden by merge process
                                .getOne()) as any

                        if (loadedReturningColumns) {
                            this.queryRunner.manager.merge(
                                metadata.target as any,
                                entity,
                                loadedReturningColumns,
                            )
                            updateResult.generatedMaps.push(
                                loadedReturningColumns,
                            )
                        }
                    }
                }
            }),
        )
    }

    /**
     * Updates entities with a special columns after insertion query execution.
     */
    async insert(
        insertResult: InsertResult,
        entities: ObjectLiteral[],
    ): Promise<void> {
        const metadata = this.expressionMap.mainAlias!.metadata

        const generatedMaps = entities.map((entity, entityIndex) => {
            if (
                Array.isArray(insertResult.raw) &&
                this.expressionMap.extraReturningColumns.length > 0
            ) {
                if (
                    this.queryRunner.connection.driver.options.type === "oracle"
                ) {
                    insertResult.raw = insertResult.raw.reduce(
                        (newRaw, rawItem, rawItemIndex) => {
                            newRaw[
                                this.expressionMap.extraReturningColumns[
                                    rawItemIndex
                                ].databaseName
                            ] = rawItem[0]
                            return newRaw
                        },
                        {} as ObjectLiteral,
                    )
                } else if (
                    this.queryRunner.connection.driver.options.type ===
                    "spanner"
                ) {
                    insertResult.raw = insertResult.raw[0]
                }
            }

            // get all values generated by a database for us
            const result = Array.isArray(insertResult.raw)
                ? insertResult.raw[entityIndex]
                : insertResult.raw

            const generatedMap =
                this.queryRunner.connection.driver.createGeneratedMap(
                    metadata,
                    result,
                    entityIndex,
                    entities.length,
                ) || {}

            if (entityIndex in this.expressionMap.locallyGenerated) {
                this.queryRunner.manager.merge(
                    metadata.target as any,
                    generatedMap,
                    this.expressionMap.locallyGenerated[entityIndex],
                )
            }

            this.queryRunner.manager.merge(
                metadata.target as any,
                entity,
                generatedMap,
            )

            return generatedMap
        })

        let insertionColumns = metadata.getInsertionReturningColumns()

        // to prevent extra select SQL execution for databases not supporting RETURNING
        // in the case if we have generated column and it's value returned by underlying driver
        // we remove this column from the insertionColumns list
        const isReturningClauseSupported =
            this.queryRunner.connection.driver.isReturningSqlSupported("insert")
        insertionColumns = insertionColumns.filter((column) => {
            if (!column.isGenerated) return true
            return isReturningClauseSupported === true
        })

        // for postgres and mssql we use returning/output statement to get values of inserted default and generated values
        // for other drivers we have to re-select this data from the database
        if (!isReturningClauseSupported) {
            const entityIds: ObjectLiteral[] = []
            const conflictBasedEntities: {
                entity: ObjectLiteral
                index: number
            }[] = []

            // when an upsert results in an UPDATE (conflict resolution), createGeneratedMap() may not populate the entity’s ID.
            // to work around this, we handle entities without an explicit ID separately and re-select them using the conflict columns.
            // 1. entities with IDs - can be re-selected using primary key
            // 2. entities without IDs (conflict resolution cases) - need conflict column-based identification
            entities.forEach((entity, index) => {
                const entityId = metadata.getEntityIdMap(entity)
                if (!entityId) {
                    conflictBasedEntities.push({ entity, index })
                } else {
                    entityIds.push(entityId)
                }
            })

            const returningResult: any[] = new Array(entities.length)

            // use upsert's conflict resolution to re-identify entities without pk
            if (conflictBasedEntities.length > 0) {
                const conflictColumns = this.getConflictColumns()

                if (conflictColumns.length > 0) {
                    await Promise.all(
                        conflictBasedEntities.map(async ({ entity, index }) => {
                            const whereCondition: ObjectLiteral = {}
                            conflictColumns.forEach((column) => {
                                const value = column.getEntityValue(entity)
                                if (value !== undefined && value !== null) {
                                    whereCondition[column.propertyPath] = value
                                }
                            })

                            if (Object.keys(whereCondition).length > 0) {
                                const conflictResult =
                                    await this.queryRunner.manager
                                        .createQueryBuilder()
                                        .select(
                                            metadata.primaryColumns.map(
                                                (column) =>
                                                    metadata.targetName +
                                                    "." +
                                                    column.propertyPath,
                                            ),
                                        )
                                        .addSelect(
                                            insertionColumns.map(
                                                (column) =>
                                                    metadata.targetName +
                                                    "." +
                                                    column.propertyPath,
                                            ),
                                        )
                                        .from(
                                            metadata.target,
                                            metadata.targetName,
                                        )
                                        .where(whereCondition)
                                        .setOption("create-pojo")
                                        .getOne()

                                if (conflictResult) {
                                    returningResult[index] = conflictResult
                                }
                            }
                        }),
                    )
                }
            }

            if (insertionColumns.length > 0 && entityIds.length > 0) {
                const resultWithIds = await this.queryRunner.manager
                    .createQueryBuilder()
                    .select(
                        metadata.primaryColumns.map(
                            (column) =>
                                metadata.targetName + "." + column.propertyPath,
                        ),
                    )
                    .addSelect(
                        insertionColumns.map(
                            (column) =>
                                metadata.targetName + "." + column.propertyPath,
                        ),
                    )
                    .from(metadata.target, metadata.targetName)
                    .where(entityIds)
                    .setOption("create-pojo")
                    .getMany()

                // map results back to correct positions
                let resultIndex = 0
                entities.forEach((entity, index) => {
                    const entityId = metadata.getEntityIdMap(entity)
                    if (
                        entityId &&
                        Object.values(entityId).every(
                            (val) => val !== undefined && val !== null,
                        )
                    ) {
                        returningResult[index] = resultWithIds[resultIndex++]
                    }
                })
            }

            entities.forEach((entity, entityIndex) => {
                this.queryRunner.manager.merge(
                    metadata.target as any,
                    generatedMaps[entityIndex],
                    returningResult[entityIndex],
                )

                this.queryRunner.manager.merge(
                    metadata.target as any,
                    entity,
                    returningResult[entityIndex],
                )
            })
        }

        entities.forEach((entity, entityIndex) => {
            const entityId = metadata.getEntityIdMap(entity)!
            insertResult.identifiers.push(entityId)
            insertResult.generatedMaps.push(generatedMaps[entityIndex])
        })
    }

    /**
     * Columns we need to be returned from the database when we update entity.
     */
    getUpdationReturningColumns(): ColumnMetadata[] {
        return this.expressionMap.mainAlias!.metadata.columns.filter(
            (column) => {
                return (
                    column.asExpression !== undefined ||
                    column.isUpdateDate ||
                    column.isVersion
                )
            },
        )
    }

    /**
     * Columns we need to be returned from the database when we soft delete and restore entity.
     */
    getSoftDeletionReturningColumns(): ColumnMetadata[] {
        return this.expressionMap.mainAlias!.metadata.columns.filter(
            (column) => {
                return (
                    column.asExpression !== undefined ||
                    column.isUpdateDate ||
                    column.isVersion ||
                    column.isDeleteDate
                )
            },
        )
    }

    /**
     * Get conflict columns from expression map onUpdate configuration
     */
    private getConflictColumns(): ColumnMetadata[] {
        const metadata = this.expressionMap.mainAlias!.metadata
        const conflictColumns: ColumnMetadata[] = []

        if (this.expressionMap.onUpdate?.conflict) {
            const conflicts = Array.isArray(
                this.expressionMap.onUpdate.conflict,
            )
                ? this.expressionMap.onUpdate.conflict
                : [this.expressionMap.onUpdate.conflict]

            conflicts.forEach((conflictPath) => {
                const column = metadata.columns.find(
                    (col) => col.databaseName === conflictPath,
                )
                if (column) {
                    conflictColumns.push(column)
                }
            })
        }

        return conflictColumns
    }
}
