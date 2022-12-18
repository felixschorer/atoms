import {
    DerivedNode,
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

export abstract class ReadonlyAtom<out T> {
    protected abstract readonly _node: SourceNode<T>

    get(): T {
        return getValue(this._node)
    }
}

export class Atom<in out T> extends ReadonlyAtom<T> {
    protected readonly _node: ValueNode<T>

    constructor(value: T) {
        super()
        this._node = makeValueNode(value)
    }

    set(value: T): T {
        return setValue(this._node, value)
    }

    update(map: (value: T) => T): T {
        const updatedValue = map(this.get())
        return this.set(updatedValue)
    }
}

export function atom<T>(value: T): Atom<T> {
    return new Atom(value)
}

export class DerivedAtom<out T> extends ReadonlyAtom<T> {
    protected readonly _node: DerivedNode<T>

    constructor(derive: () => T) {
        super()
        this._node = makeDerivedNode(derive)
    }
}

export function derivedAtom<T>(derive: () => T): DerivedAtom<T> {
    return new DerivedAtom(derive)
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
