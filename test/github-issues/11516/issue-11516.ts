import "reflect-metadata"
import {
    closeTestingConnections,
    createTestingConnections,
    reloadTestingDatabases,
} from "../../utils/test-utils"
import { DataSource } from "../../../src/data-source/DataSource"
import { Test } from "./entity/Test"
import { expect } from "chai"

describe.only("github issues > #11516 upsert should set entity id after conflict resolution", () => {
    let connections: DataSource[]
    before(
        async () =>
            (connections = await createTestingConnections({
                entities: [__dirname + "/entity/*{.js,.ts}"],
                enabledDrivers: ["mariadb", "postgres", "sqlite"],
            })),
    )
    beforeEach(() => reloadTestingDatabases(connections))
    after(() => closeTestingConnections(connections))

    it("should set entity id when upsert performs INSERT (new record)", () =>
        Promise.all(
            connections.map(async (connection) => {
                if (!connection.driver.supportedUpsertTypes.length) return

                const testRepository = connection.getRepository(Test)

                // 새로운 엔티티 삽입
                const entity: any = {
                    key1: "test",
                    key2: "data",
                    value: "initial",
                }

                const result = await testRepository.upsert(entity, [
                    "key1",
                    "key2",
                ])

                // INSERT 후 entity에 ID가 설정되어야 함
                expect(entity).to.have.property("id")
                expect(entity.id).to.be.a("number")
                expect(entity.id).to.be.greaterThan(0)

                // 결과 검증
                expect(result.identifiers).to.have.lengthOf(1)
                expect(result.identifiers[0]).to.have.property("id")
            }),
        ))

    it("should set entity id when upsert performs UPDATE (conflict resolution)", () =>
        Promise.all(
            connections.map(async (connection) => {
                if (!connection.driver.supportedUpsertTypes.length) return

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

                // UPDATE 후에도 entity에 ID가 설정되어야 함 (핵심 테스트)
                expect(conflictEntity).to.have.property("id")
                expect(conflictEntity.id).to.be.a("number")
                expect(conflictEntity.id).to.equal(originalId) // 기존 ID와 동일해야 함

                // DB에서 실제로 업데이트되었는지 확인
                const dbEntity = await testRepository.findOne({
                    where: { id: originalId },
                })
                expect(dbEntity).to.not.be.null
                expect(dbEntity!.value).to.equal("updated")
                expect(dbEntity!.key1).to.equal("conflict")
                expect(dbEntity!.key2).to.equal("test")

                // 결과 검증
                expect(result.identifiers).to.have.lengthOf(1)
                expect(result.identifiers[0]).to.have.property("id")
                expect(result.identifiers[0].id).to.equal(originalId)
            }),
        ))
})
