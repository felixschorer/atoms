export const enum CacheType {
    VALUE,
    ERROR,
    UNINITIALIZED,
}

export interface CachedValue<T> {
    type: CacheType.VALUE
    value: T
    error: null
}

export interface CachedError {
    type: CacheType.ERROR
    value: null
    error: unknown
}

export interface Uninitialized {
    type: CacheType.UNINITIALIZED
    value: null
    error: null
}

export type Cache<T = unknown> = CachedValue<T> | CachedError | Uninitialized

export const enum NodeType {
    VALUE,
    DERIVED,
    LISTENER,
}

export interface SourceCommon<T> {
    /** current, possibly uncommitted value */
    value: T
    /** must be referentially equal to {@link value} when in committed state */
    committedValue: T
    /** keeps track of the subscribed targets and their subscription count */
    targets: Map<WeakRef<TargetNode>, number>
}

export interface TargetCommon {
    /** weak self reference */
    weakRef: WeakRef<this>
    /** sources which are tracked by the target */
    sources: Array<SourceNode>
    /** keeps track of invalidated sources, a {@link SourceNode} may be counted multiple times */
    invalidatedSourcesCount: number
    /** flag whether the target function is currently running, e.g. side effect or recompute */
    running: boolean
}

export interface ValueNode<T = unknown> extends SourceCommon<T> {
    type: NodeType.VALUE
}

export interface DerivedNode<T = unknown> extends SourceCommon<Cache<T>>, TargetCommon {
    type: NodeType.DERIVED
    /** function to derive a new value */
    derive: () => T
}

export interface ListenerNode extends TargetCommon {
    type: NodeType.LISTENER
    /** callback to notify the listener that the tracked sources have changed */
    notify: () => void
}

export type SourceNode<T = unknown> = ValueNode<T> | DerivedNode<T>
export type TargetNode = DerivedNode | ListenerNode

export interface ExecutionContext {
    /** current target for tracking sources */
    currentTarget: TargetNode | null
    /** index into the sources array of {@link currentTarget} */
    sourceIndex: number
    /** flag whether the current target should be rolled back */
    rollback: boolean
}

export interface UpdateContext {
    /** flag whether a batch is currently active */
    batched: boolean
    /** sources which need to be committed at the end of the batch */
    uncommittedSources: Set<SourceNode>
    /** listeners which need to be executed at the end of the batch */
    invalidatedListeners: Set<ListenerNode>
}

export const EXECUTION: ExecutionContext = {
    currentTarget: null,
    sourceIndex: 0,
    rollback: false,
}

export const UPDATE: UpdateContext = {
    batched: false,
    uncommittedSources: new Set(),
    invalidatedListeners: new Set(),
}

export function runInContext<T>(target: TargetNode, fn: () => T): T {
    if (target.running) {
        throw new Error("Cyclic dependency.")
    }

    const parentTarget = EXECUTION.currentTarget
    const parentSourceIndex = EXECUTION.sourceIndex

    if (target.type === NodeType.LISTENER && parentTarget?.type === NodeType.DERIVED) {
        throw new Error("Side effect within derived.")
    }

    target.running = true
    EXECUTION.currentTarget = target
    EXECUTION.sourceIndex = 0
    try {
        return fn()
    } finally {
        for (let i = EXECUTION.sourceIndex; i < target.sources.length; i++) {
            unsubscribe(target.sources[i]!, target)
        }
        target.sources.length = EXECUTION.sourceIndex + 1

        target.running = false
        EXECUTION.currentTarget = parentTarget
        EXECUTION.sourceIndex = parentSourceIndex
    }
}

export function makeValueNode<T>(value: T): ValueNode<T> {
    return {
        type: NodeType.VALUE,
        value,
        committedValue: value,
        targets: new Map(),
    }
}

export function makeDerivedNode<T>(derive: () => T) {
    const value: Cache = { type: CacheType.UNINITIALIZED, value: null, error: null }
    const node: DerivedNode<T> = {
        type: NodeType.DERIVED,
        derive,
        value,
        committedValue: value,
        targets: new Map(),
        weakRef: null as never as WeakRef<DerivedNode<T>>,
        sources: [],
        invalidatedSourcesCount: 0,
        running: false,
    }
    node.weakRef = new WeakRef(node)
    return node
}

export function makeListenerNode(notify: () => void) {
    const node: ListenerNode = {
        type: NodeType.LISTENER,
        notify,
        weakRef: null as never as WeakRef<ListenerNode>,
        sources: [],
        invalidatedSourcesCount: 0,
        running: false,
    }
    node.weakRef = new WeakRef(node)
    return node
}

export function isInvalidated(target: TargetNode): boolean {
    return target.invalidatedSourcesCount > 0
}

export function isUncommitted(source: SourceNode): boolean {
    return source.value !== source.committedValue
}

export function isInvalidatedOrUncommitted(source: SourceNode): boolean {
    return isUncommitted(source) || (source.type === NodeType.DERIVED && isInvalidated(source))
}

export function setValue<T>(valueNode: ValueNode<T>, value: T) {
    if (valueNode.value === value) return

    valueNode.value = value

    if (!UPDATE.batched) {
        valueNode.committedValue = value
        markAsInvalid(valueNode)
        runListeners()
    } else if (valueNode.committedValue === value) {
        markAsValid(valueNode)
    } else {
        markAsInvalid(valueNode)
    }
}

export function commitSources() {
    for (const source of UPDATE.uncommittedSources) {
        UPDATE.uncommittedSources.delete(source)
        source.committedValue = source.value
    }
}

export function runListeners() {
    for (const listener of UPDATE.invalidatedListeners) {
        UPDATE.invalidatedListeners.delete(listener)
        runListener(listener)
    }
}

export function runListener(listener: ListenerNode) {
    for (const source of listener.sources) {
        if (!isInvalidated(listener)) return

        if (source.type === NodeType.DERIVED) {
            recompute(source)
        }
    }

    listener.invalidatedSourcesCount = 0
    listener.notify()
}

export function dispose(listener: ListenerNode) {
    for (const source of listener.sources) {
        unsubscribe(source, listener)
    }
}

export function markAsInvalid(source: SourceNode): void {
    if (source.type === NodeType.DERIVED && isInvalidated(source)) return
    if (source.type === NodeType.DERIVED && isUncommitted(source)) return rollback(source)

    for (const [targetRef, subscriptionCount] of source.targets) {
        const target = targetRef.deref()
        if (!target) {
            source.targets.delete(targetRef)
            continue
        }
        if (target.type === NodeType.DERIVED) {
            markAsInvalid(target)
        } else {
            UPDATE.invalidatedListeners.add(target)
        }
        // Increase count only after recursively calling invalidate.
        // Otherwise, DerivedNodes won't pass the above isInvalidated check.
        target.invalidatedSourcesCount += subscriptionCount
    }
}

export function markAsValid(source: SourceNode) {
    for (const [targetRef, subscriptionCount] of source.targets) {
        const target = targetRef.deref()
        if (!target) {
            source.targets.delete(targetRef)
            continue
        }
        if (target.type === NodeType.DERIVED && isUncommitted(target)) {
            rollback(target)
        } else {
            target.invalidatedSourcesCount -= subscriptionCount
            if (target.type === NodeType.DERIVED && isInvalidated(target)) {
                markAsValid(target)
            }
        }
    }
}

export function recompute<T>(derived: DerivedNode<T>): void {
    if (derived.value.type !== CacheType.UNINITIALIZED && !isInvalidated(derived)) return
    try {
        const value = runInContext(derived, derived.derive)
        const unchanged =
            derived.value.type === CacheType.VALUE &&
            (derived.value.value === value || !isInvalidated(derived))

        if (unchanged) {
            markAsValid(derived)
        } else {
            setDerivedValue(derived, value)
        }
    } catch (error) {
        if (derived.value.type === CacheType.ERROR && !isInvalidated(derived)) {
            markAsValid(derived)
        } else {
            setDerivedError(derived, error)
        }
    } finally {
        derived.invalidatedSourcesCount = 0
    }
}

export function setDerivedValue<T>(derived: DerivedNode<T>, value: T): void {
    if (UPDATE.batched) {
        derived.value = { type: CacheType.VALUE, value, error: null }
    } else {
        ;(derived.value as CachedValue<T>).type = CacheType.VALUE
        ;(derived.value as CachedValue<T>).value = value
        ;(derived.value as CachedValue<T>).error = null
    }
}

export function setDerivedError(derived: DerivedNode, error: unknown): void {
    if (UPDATE.batched) {
        derived.value = { type: CacheType.ERROR, value: null, error }
    } else {
        ;(derived.value as CachedError).type = CacheType.ERROR
        ;(derived.value as CachedError).value = null
        ;(derived.value as CachedError).error = error
    }
}

export function setUninitialized(derived: DerivedNode): void {
    if (UPDATE.batched) {
        derived.value = { type: CacheType.UNINITIALIZED, value: null, error: null }
    } else {
        ;(derived.value as Uninitialized).type = CacheType.UNINITIALIZED
        ;(derived.value as Uninitialized).value = null
        ;(derived.value as Uninitialized).error = null
    }
}

export function rollback(derived: DerivedNode): void {
    derived.value = derived.committedValue

    EXECUTION.rollback = true
    try {
        runInContext(derived, derived.derive)
    } finally {
        EXECUTION.rollback = false
        derived.invalidatedSourcesCount = 0
        for (const upstream of derived.sources) {
            if (isInvalidatedOrUncommitted(upstream)) {
                derived.invalidatedSourcesCount++
            }
        }
    }

    if (!isInvalidated(derived)) {
        return markAsValid(derived)
    }

    for (const targetRef of derived.targets.keys()) {
        const target = targetRef.deref()
        if (!target) {
            derived.targets.delete(targetRef)
        } else if (target.type === NodeType.DERIVED && isUncommitted(target)) {
            rollback(target)
        }
    }
}

export function subscribe(source: SourceNode, target: TargetNode) {
    const subscriptionCount = source.targets.get(target.weakRef)
    if (!subscriptionCount) {
        source.targets.set(target.weakRef, 1)
    } else {
        source.targets.set(target.weakRef, subscriptionCount + 1)
    }
}

export function unsubscribe(source: SourceNode, target: TargetNode) {
    const subscriptionCount = source.targets.get(target.weakRef)
    if (!subscriptionCount) {
        return
    } else if (subscriptionCount > 1) {
        source.targets.set(target.weakRef, subscriptionCount - 1)
    } else {
        source.targets.delete(target.weakRef)
        if (source.type === NodeType.DERIVED && isInvalidated(source)) {
            for (const upstream of source.sources) {
                unsubscribe(upstream, source)
            }
            setUninitialized(source)
            source.sources.length = 0
        }
    }
}

export function getValueTracked<T>(source: SourceNode<T>): T {
    if (EXECUTION.currentTarget) {
        const sources = EXECUTION.currentTarget.sources
        const previousSource = sources[EXECUTION.sourceIndex]
        if (source !== previousSource) {
            sources[EXECUTION.sourceIndex] = source
            subscribe(source, EXECUTION.currentTarget)
            if (previousSource) {
                unsubscribe(previousSource, EXECUTION.currentTarget)
            }
        }
        EXECUTION.sourceIndex++
    }
    return getValue(source)
}

export function getValue<T>(source: SourceNode<T>): T {
    if (source.type === NodeType.VALUE) {
        return EXECUTION.rollback ? source.committedValue : source.value
    } else {
        if (EXECUTION.rollback) {
            return unwrapCache(source.committedValue)
        }
        recompute(source)
        return unwrapCache(source.value)
    }
}

export function unwrapCache<T>(cache: Cache<T>): T {
    switch (cache.type) {
        case CacheType.VALUE:
            return cache.value
        case CacheType.ERROR:
            throw cache.error
        case CacheType.UNINITIALIZED:
            throw new Error("Unwrapping uninitialized cache.")
    }
}
