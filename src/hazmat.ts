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

interface SourceCommon<T> {
    /** current, possibly uncommitted value */
    value: T
    /** must be referentially equal to {@link value} when in committed state */
    committedValue: T
    /** keeps track of the subscribed targets and their subscription count */
    targets: Map<WeakRef<TargetNode>, number>
}

interface TargetCommon {
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

export type Node<T = unknown> = ValueNode<T> | DerivedNode<T> | ListenerNode
export type SourceNode<T = unknown> = ValueNode<T> | DerivedNode<T>
export type TargetNode = DerivedNode | ListenerNode

interface ExecutionContext {
    /** current target for tracking sources */
    currentTarget: TargetNode | null
    /** index into the sources array of {@link currentTarget} */
    sourceIndex: number
    /** flag whether the current target should be rolled back */
    rollback: boolean
}

interface UpdateContext {
    /** flag whether a batch is currently active */
    batched: boolean
    /** sources which need to be committed at the end of the batch */
    uncommittedSourceNodes: Set<SourceNode>
    /** listeners which need to be executed at the end of the batch */
    invalidatedListenerNodes: Set<ListenerNode>
}

const EXECUTION: ExecutionContext = {
    currentTarget: null,
    sourceIndex: 0,
    rollback: false,
}

export const UPDATE: UpdateContext = {
    batched: false,
    uncommittedSourceNodes: new Set(),
    invalidatedListenerNodes: new Set(),
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

function isInvalidated(target: TargetNode): boolean {
    return target.invalidatedSourcesCount > 0
}

function isUncommitted(source: SourceNode): boolean {
    return source.value !== source.committedValue
}

function isInvalidatedOrUncommitted(node: Node): boolean {
    switch (node.type) {
        case NodeType.VALUE:
            return isUncommitted(node)
        case NodeType.DERIVED:
            return isUncommitted(node) || isInvalidated(node)
        case NodeType.LISTENER:
            return isInvalidated(node)
    }
}

export function setValue<T>(valueNode: ValueNode<T>, value: T) {
    if (valueNode.value === value) return

    valueNode.value = value

    if (!UPDATE.batched) {
        valueNode.committedValue = value
        invalidate(valueNode)
        runListeners()
    } else if (valueNode.committedValue === value) {
        revalidate(valueNode)
    } else {
        invalidate(valueNode)
    }
}

export function commitSources() {
    for (const source of UPDATE.uncommittedSourceNodes) {
        UPDATE.uncommittedSourceNodes.delete(source)
        source.committedValue = source.value
    }
}

export function runListeners() {
    for (const listener of UPDATE.invalidatedListenerNodes) {
        UPDATE.invalidatedListenerNodes.delete(listener)
        runListener(listener)
    }
}

function runListener(listener: ListenerNode) {
    for (const source of listener.sources) {
        if (!isInvalidated(listener)) return

        if (source.type === NodeType.DERIVED) {
            recompute(source)
        }
    }

    listener.invalidatedSourcesCount = 0
    listener.notify()
}

export function disposeListener(listener: ListenerNode) {
    for (const source of listener.sources) {
        unsubscribe(source, listener)
    }
}

function invalidate(source: SourceNode): void {
    if (source.type === NodeType.DERIVED && isInvalidated(source)) return
    if (source.type === NodeType.DERIVED && isUncommitted(source)) return rollback(source)

    for (const [targetRef, subscriptionCount] of source.targets) {
        const target = targetRef.deref()
        if (!target) {
            source.targets.delete(targetRef)
            continue
        }
        if (target.type === NodeType.DERIVED) {
            invalidate(target)
        } else {
            UPDATE.invalidatedListenerNodes.add(target)
        }
        // Increase count only after recursively calling invalidate.
        // Otherwise, DerivedNodes won't pass the above isInvalidated check.
        target.invalidatedSourcesCount += subscriptionCount
    }
}

function revalidate(source: SourceNode) {
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
                revalidate(target)
            }
        }
    }
}

function recompute<T>(derived: DerivedNode<T>): void {
    if (derived.value.type !== CacheType.UNINITIALIZED && !isInvalidated(derived)) return
    try {
        const value = runInContext(derived, derived.derive)
        const unchanged =
            derived.value.type === CacheType.VALUE &&
            (derived.value.value === value || !isInvalidated(derived))

        if (unchanged) {
            revalidate(derived)
        } else {
            setDerivedValue(derived, value)
        }
    } catch (error) {
        if (derived.value.type === CacheType.ERROR && !isInvalidated(derived)) {
            revalidate(derived)
        } else {
            setDerivedError(derived, error)
        }
    } finally {
        derived.invalidatedSourcesCount = 0
    }
}

function setDerivedValue<T>(derived: DerivedNode<T>, value: T): void {
    if (UPDATE.batched) {
        derived.value = { type: CacheType.VALUE, value, error: null }
    } else {
        ;(derived.value as CachedValue<T>).type = CacheType.VALUE
        ;(derived.value as CachedValue<T>).value = value
        ;(derived.value as CachedValue<T>).error = null
    }
}

function setDerivedError(derived: DerivedNode, error: unknown): void {
    if (UPDATE.batched) {
        derived.value = { type: CacheType.ERROR, value: null, error }
    } else {
        ;(derived.value as CachedError).type = CacheType.ERROR
        ;(derived.value as CachedError).value = null
        ;(derived.value as CachedError).error = error
    }
}

function setDerivedUninitialized(derived: DerivedNode): void {
    if (UPDATE.batched) {
        derived.value = { type: CacheType.UNINITIALIZED, value: null, error: null }
    } else {
        ;(derived.value as Uninitialized).type = CacheType.UNINITIALIZED
        ;(derived.value as Uninitialized).value = null
        ;(derived.value as Uninitialized).error = null
    }
}

function rollback(derived: DerivedNode): void {
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
        return revalidate(derived)
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

function subscribe(source: SourceNode, target: TargetNode) {
    const subscriptionCount = source.targets.get(target.weakRef)
    if (!subscriptionCount) {
        source.targets.set(target.weakRef, 1)
    } else {
        source.targets.set(target.weakRef, subscriptionCount + 1)
    }
}

function unsubscribe(source: SourceNode, target: TargetNode) {
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
            setDerivedUninitialized(source)
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
    switch (source.type) {
        case NodeType.VALUE:
            return EXECUTION.rollback ? source.committedValue : source.value
        case NodeType.DERIVED:
            if (EXECUTION.rollback) {
                return unwrapCache(source.committedValue)
            }
            recompute(source)
            return unwrapCache(source.value)
    }
}

function unwrapCache<T>(cache: Cache<T>): T {
    switch (cache.type) {
        case CacheType.VALUE:
            return cache.value
        case CacheType.ERROR:
            throw cache.error
        case CacheType.UNINITIALIZED:
            throw new Error("Unwrapping uninitialized cache.")
    }
}
