import {
    CacheType,
    getValue,
    makeDerivedNode,
    makeEffectNode,
    makeValueNode,
    runInContext,
    setValue,
} from "./hazmat"

describe("hazardous materials", () => {
    describe("invalidation", () => {
        it("should dispose the invalidated derived node", () => {
            const s = makeValueNode(1)
            const d = makeDerivedNode(() => getValue(s))

            // initialize d
            getValue(d)
            expect(d.value.value).toBe(1)
            expect(d.sources).toEqual([s])
            expect(s.targets).toEqual(new Map([[d.weakRef, 1]]))

            // invalidate s
            setValue(s, 2)
            expect(d.value.type).toBe(CacheType.UNINITIALIZED)
            expect(d.sources).toEqual([])
            expect(s.targets).toEqual(new Map([]))
        })

        it("should dispose the invalidated derived nodes", () => {
            const s = makeValueNode(1)
            const d1 = makeDerivedNode(() => getValue(s))
            const d2 = makeDerivedNode(() => getValue(d1))
            const d3 = makeDerivedNode(() => getValue(d2))
            const d4 = makeDerivedNode(() => getValue(d2) + getValue(d3))

            // initialize d1, d2, d3, d4
            getValue(d4)
            expect(d1.value.value).toBe(1)
            expect(d2.value.value).toBe(1)
            expect(d3.value.value).toBe(1)
            expect(d4.value.value).toBe(2)

            // invalidate d1, d2, d3, d4
            setValue(s, 2)
            expect(d1.value.type).toBe(CacheType.UNINITIALIZED)
            expect(d2.value.type).toBe(CacheType.UNINITIALIZED)
            expect(d3.value.type).toBe(CacheType.UNINITIALIZED)
            expect(d4.value.type).toBe(CacheType.UNINITIALIZED)
        })
    })

    it("should notify the effect on changes", () => {
        const callback = jest.fn()

        const valueNode = makeValueNode(0)
        const effectNode = makeEffectNode(() => callback(getValue(valueNode)))
        runInContext(effectNode, () => getValue(valueNode))

        setValue(valueNode, 0)
        setValue(valueNode, 1)
        setValue(valueNode, 2)

        expect(callback.mock.calls).toEqual([[1], [2]])
    })

    it("should notify the effect on derived changes", () => {
        const callback = jest.fn()

        const valueNode = makeValueNode(0)
        const derivedNode = makeDerivedNode(() => getValue(valueNode) * 2)
        const effectNode = makeEffectNode(() => callback(getValue(derivedNode)))
        runInContext(effectNode, () => getValue(derivedNode))

        setValue(valueNode, 0)
        setValue(valueNode, 1)
        setValue(valueNode, 2)

        expect(callback.mock.calls).toEqual([[2], [4]])
    })

    it("should not notify the effect if the derived value stayed the same", () => {
        const callback = jest.fn()

        const valueNode = makeValueNode(0)
        const derivedNode1 = makeDerivedNode(() => getValue(valueNode) & 0)
        const derivedNode2 = makeDerivedNode(() => getValue(derivedNode1))
        const effectNode = makeEffectNode(() => callback(getValue(derivedNode2)))
        runInContext(effectNode, () => getValue(derivedNode2))

        setValue(valueNode, 0)
        setValue(valueNode, 1)
        setValue(valueNode, 2)

        expect(callback).toHaveBeenCalledTimes(0)
    })

    it("should notify the effect only once in diamond structure", () => {
        const callback = jest.fn()

        const valueNode = makeValueNode(0)
        const derivedNode1 = makeDerivedNode(() => getValue(valueNode) * 2)
        const derivedNode2 = makeDerivedNode(() => getValue(valueNode) * 5)
        const effectNode = makeEffectNode(() =>
            callback(getValue(derivedNode1), getValue(derivedNode2)),
        )
        runInContext(effectNode, () => {
            getValue(derivedNode1)
            getValue(derivedNode2)
        })

        setValue(valueNode, 0)
        setValue(valueNode, 1)
        setValue(valueNode, 2)

        expect(callback.mock.calls).toEqual([
            [2, 5],
            [4, 10],
        ])
    })

    it("should not uninvalidate a derived node if at least one other source is invalid", () => {
        const callback = jest.fn()

        const valueNode = makeValueNode(0)
        const derivedNode1 = makeDerivedNode(() => getValue(valueNode) & 0)
        const derivedNode2 = makeDerivedNode(() => getValue(valueNode))
        const derivedNode3 = makeDerivedNode(() => getValue(derivedNode1) + getValue(derivedNode2))
        const effectNode = makeEffectNode(() => callback(getValue(derivedNode3)))
        runInContext(effectNode, () => getValue(derivedNode3))

        setValue(valueNode, 0)
        setValue(valueNode, 1)
        setValue(valueNode, 2)

        expect(callback).toHaveBeenCalledTimes(2)
    })
})
