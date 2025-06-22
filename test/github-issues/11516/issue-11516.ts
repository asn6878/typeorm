import "reflect-metadata"
import {
    closeTestingConnections,
    createTestingConnections,
    reloadTestingDatabases,
} from "../../utils/test-utils"
import { DataSource } from "../../../src/data-source/DataSource"
import { Test } from "./entity/Test"
import { expect } from "chai"

describe("github issues > #11516 upsert should set entity id after conflict resolution", () => {
    let connections: DataSource[]
    before(
        async () =>
            (connections = await createTestingConnections({
                entities: [__dirname + "/entity/*{.js,.ts}"],
                enabledDrivers: ["postgres", "mysql"],
                schemaCreate: true,
                dropSchema: true,
            })),
    )
    beforeEach(() => reloadTestingDatabases(connections))
    after(() => closeTestingConnections(connections))

    it("should set entity id when upsert performs UPDATE (conflict resolution)", async () =>
        await Promise.all(
            connections.map(async (connection) => {
                const testRepository = connection.getRepository(Test)

                const initialEntity = new Test()
                initialEntity.key1 = "conflict"
                initialEntity.key2 = "test"
                initialEntity.value = "original"
                const savedEntity = await testRepository.save(initialEntity)

                expect(savedEntity.id).to.be.a("number")
                expect(savedEntity.id).to.be.greaterThan(0)
                const originalId = savedEntity.id

                const conflictEntity: any = {
                    key1: "conflict",
                    key2: "test",
                    value: "updated",
                }

                const result = await testRepository.upsert(conflictEntity, [
                    "key1",
                    "key2",
                ])

                expect(conflictEntity).to.have.property("id")
                expect(conflictEntity.id).to.be.a("number")
                expect(conflictEntity.id).to.equal(originalId)

                const dbEntity = await testRepository.findOne({
                    where: { id: originalId },
                })
                expect(dbEntity).to.not.be.null
                expect(dbEntity!.value).to.equal("updated")
                expect(dbEntity!.key1).to.equal("conflict")
                expect(dbEntity!.key2).to.equal("test")

                expect(result.identifiers).to.have.lengthOf(1)
                expect(result.identifiers[0]).to.have.property("id")
                expect(result.identifiers[0].id).to.equal(originalId)
            }),
        ))
})
