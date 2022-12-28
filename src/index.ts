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
    untracked,
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


// ---------------------
// --- subscriptions ---
// ---------------------

export class Subsription {
    readonly active = atom(true);
}

export interface SubscriptionOptions {
    handleError?: (error: any) => void;
}

export function subscribe(atoms: ReadonlyAtom<unknown>[], callback: () => void, options?: SubscriptionOptions): Subsription {
    const subsription = new Subsription();
    effect(() => {
        atoms.forEach(atom => atom.get()); // maybe use some hazmat here?
        if (!subsription.active.get()) {
            return;
        }
        untracked(() => {
            try {
                callback();
            } catch (error) {
                options?.handleError?.(error);
            }
        });
    });
    return subsription;
}

export class AsyncSubsription extends Subsription {
    constructor(readonly _processing: ReadonlyAtom<boolean>) {
        super();
    }

    get processing(): ReadonlyAtom<boolean> {
        return this._processing;
    }
}

export interface SubscriptionAsyncOptions extends SubscriptionOptions {
    backpressureType?: 'debounce' | 'skip';
    processing?: Atom<boolean>;
}

export function subscribeAsync(atoms: ReadonlyAtom<unknown>[], callback: () => Promise<void>, options?: SubscriptionAsyncOptions): AsyncSubsription {
    const processing = atom(false);
    const asyncSubsription = new AsyncSubsription(processing);
    effect(() => {
        atoms.forEach(atom => atom.get()); // maybe use some hazmat here?
        if (!asyncSubsription.active.get()) {
            return;
        }
        processing.set(true);
        untracked(() => {
            // TODO backpressure
            callback()
                .then(() => {
                    processing.set(true); // should be tracked
                })
                .catch(error => {
                    processing.set(true); // should be tracked
                    options?.handleError?.(error);
                });
        });
    });
    return asyncSubsription;
}

// ---------------------
// --- derived async ---
// ---------------------

type UnwrapValue<N> = N extends ReadonlyAtom<infer T> ? T : N;

export class AsyncReadonlyAtom<T> extends AsyncSubsription {
    constructor(readonly _result: ReadonlyAtom<T | undefined>, processing: ReadonlyAtom<boolean>) {
        super(processing);
    }

    get value(): ReadonlyAtom<T | undefined> {
        return this._result;
    }
}

export function asyncDerivedAtom<T>(atoms: ReadonlyAtom<unknown>[], deriveFcn: () => Promise<T>, options?: SubscriptionAsyncOptions): AsyncReadonlyAtom<T>{
    const resultAtom = atom<T | undefined>(undefined);
    const sub = subscribeAsync(atoms, async () => {
        const result = await deriveFcn();
        resultAtom.set(result);
    }, options);
    const asyncDerivedAtom = new AsyncReadonlyAtom(resultAtom, sub.processing);
    return asyncDerivedAtom;
}
