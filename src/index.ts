import {
    cleanupNodes,
    commitSources,
    DerivedNode,
    disposeListener,
    EXECUTION,
    getValue,
    ListenerNode,
    makeDerivedNode,
    makeListenerNode,
    makeValueNode,
    NodeType,
    runInContext,
    runListeners,
    setValue,
    SourceNode,
    UPDATE,
    UpdateStatus,
    ValueNode,
} from "./hazmat"

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
        if (EXECUTION.currentTarget?.type === NodeType.DERIVED) {
            throw new Error("Cannot set value in derived context.")
        }
        setValue(this._node, value)
        return value
    }

    update(map: (value: T) => T): T {
        const updatedValue = map(this.get())
        this.set(updatedValue)
        return updatedValue
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

    private readonly _node: ListenerNode
    private _destructor: Destructor | null = null

    constructor(sideEffect: () => void | Destructor) {
        if (EXECUTION.currentTarget?.type === NodeType.DERIVED) {
            throw new Error("Cannot use effect in derived context.")
        }

        Effect.activeEffects.add(this)
        this._node = makeListenerNode(() => {
            try {
                this._destructor?.()
                this._destructor = runInContext(this._node, sideEffect) ?? null
            } catch (error) {
                Effect.errorHandler(error)
                this.dispose()
            }
        })
        this._node.notify()
    }

    dispose(): void {
        Effect.activeEffects.delete(this)
        disposeListener(this._node)
    }
}

export function effect(sideEffect: () => void | Destructor): Effect {
    return new Effect(sideEffect)
}

export function batch<T>(run: () => T): T {
    if (UPDATE.status === UpdateStatus.BATCHED) {
        return run()
    } else {
        UPDATE.status = UpdateStatus.BATCHED
        try {
            return run()
        } finally {
            UPDATE.status = UpdateStatus.INACTIVE
            commitSources()
            cleanupNodes()
            runListeners()
        }
    }
}

export function untracked<T>(run: () => T): T {
    const target = EXECUTION.currentTarget

    if (target?.type === NodeType.DERIVED) {
        throw new Error("Cannot disable tracking in derived context.")
    }

    if (!target?.tracking) return run()

    target.tracking = false
    try {
        return run()
    } finally {
        target.tracking = true
    }
}
