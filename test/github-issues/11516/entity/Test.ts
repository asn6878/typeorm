import { Entity } from "../../../../src/decorator/entity/Entity"
import { PrimaryGeneratedColumn } from "../../../../src/decorator/columns/PrimaryGeneratedColumn"
import { Column } from "../../../../src/decorator/columns/Column"
import { Index } from "../../../../src/decorator/Index"

@Index(["key1", "key2"], { unique: true })
@Entity()
export class Test {
    @PrimaryGeneratedColumn("increment")
    id: number

    @Column()
    key1: string

    @Column()
    key2: string

    @Column()
    value: string
}
