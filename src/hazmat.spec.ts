import {
    getValue,
    getValueTracked,
    makeDerivedNode,
    makeListenerNode,
    makeValueNode,
    runInContext,
    setValue,
} from "./hazmat"

describe("hazardous materials", () => {
    it("should notify the listener on changes", () => {
        const callback = jest.fn()

        const valueNode = makeValueNode(0)
        const listenerNode = makeListenerNode(() => callback(getValue(valueNode)))
        runInContext(listenerNode, () => getValueTracked(valueNode))

        setValue(valueNode, 0)
        setValue(valueNode, 1)
        setValue(valueNode, 2)

        expect(callback.mock.calls).toEqual([[1], [2]])
    })

    it("should notify the listener on derived changes", () => {
        const callback = jest.fn()

        const valueNode = makeValueNode(0)
        const derivedNode = makeDerivedNode(() => getValueTracked(valueNode) * 2)
        const listenerNode = makeListenerNode(() => callback(getValue(derivedNode)))
        runInContext(listenerNode, () => getValueTracked(derivedNode))

        setValue(valueNode, 0)
        setValue(valueNode, 1)
        setValue(valueNode, 2)

        expect(callback.mock.calls).toEqual([[2], [4]])
    })

    it("should not notify the listener if the derived value stayed the same", () => {
        const callback = jest.fn()

        const valueNode = makeValueNode(0)
        const derivedNode1 = makeDerivedNode(() => getValueTracked(valueNode) & 0)
        const derivedNode2 = makeDerivedNode(() => getValueTracked(derivedNode1))
        const listenerNode = makeListenerNode(() => callback(getValue(derivedNode2)))
        runInContext(listenerNode, () => getValueTracked(derivedNode2))

        setValue(valueNode, 0)
        setValue(valueNode, 1)
        setValue(valueNode, 2)

        expect(callback).toHaveBeenCalledTimes(0)
    })

    it("should notify the listener only once in diamond structure", () => {
        const callback = jest.fn()

        const valueNode = makeValueNode(0)
        const derivedNode1 = makeDerivedNode(() => getValueTracked(valueNode) * 2)
        const derivedNode2 = makeDerivedNode(() => getValueTracked(valueNode) * 5)
        const listenerNode = makeListenerNode(() =>
            callback(getValue(derivedNode1), getValue(derivedNode2)),
        )
        runInContext(listenerNode, () => {
            getValueTracked(derivedNode1)
            getValueTracked(derivedNode2)
        })

        setValue(valueNode, 0)
        setValue(valueNode, 1)
        setValue(valueNode, 2)

        expect(callback.mock.calls).toEqual([
            [2, 5],
            [4, 10],
        ])
    })
})
