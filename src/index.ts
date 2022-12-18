import {
    disposeEffect,
    EffectNode,
    getValue,
    makeDerivedNode,
    makeEffectNode,
    makeValueNode,
    runInContext,
    setValue,
    SourceNode,
    ValueNode,
} from "./hazmat"

export { batch, untracked } from "./hazmat"

export class ReadonlyAtom<out T> {
    constructor(readonly _node: SourceNode<T>) {}

    get(): T {
        return getValue(this._node)
    }
}

export class Atom<in out T> extends ReadonlyAtom<T> {
    constructor(value: T) {
        super(makeValueNode(value))
    }

    set(value: T): T {
        return setValue(this._node as ValueNode<T>, value)
    }

    update(map: (value: T) => T): T {
        const updatedValue = map(this.get())
        return this.set(updatedValue)
    }
}

export function atom<T>(value: T): Atom<T> {
    return new Atom(value)
}

export function derivedAtom<T>(derive: () => T): ReadonlyAtom<T> {
    return new ReadonlyAtom(makeDerivedNode(derive))
}

export type Destructor = () => void

export class Effect {
    static readonly activeEffects = new Set<Effect>()

    static errorHandler = (error: unknown) =>
        queueMicrotask(() => {
            throw error
        })

    private readonly _node: EffectNode
    private _destructor: Destructor | null = null

    constructor(sideEffect: () => void | Destructor) {
        this._node = makeEffectNode(() => {
            try {
                this._destructor?.()
                this._destructor = runInContext(this._node, sideEffect) ?? null
            } catch (error) {
                Effect.errorHandler(error)
                this.dispose()
            }
        })
        this._node.notify()
        Effect.activeEffects.add(this)
    }

    dispose(): void {
        Effect.activeEffects.delete(this)
        disposeEffect(this._node)
    }
}

export function effect(sideEffect: () => void | Destructor): Effect {
    return new Effect(sideEffect)
}
