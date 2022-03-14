import {
    assignFilteredGlobalDescriptorsFromPropertyDescriptorMap,
    createConnector,
    createMembraneMarshall,
    filterGlobalOwnKeys,
    getFilteredGlobalOwnKeys,
    linkIntrinsics,
    DistortionCallback,
    Instrumentation,
    VirtualEnvironment,
} from '@locker/near-membrane-base';

import {
    getCachedGlobalObjectReferences,
    filterWindowKeys,
    removeWindowDescriptors,
    unforgeablePoisonedWindowKeys,
} from './window';

const IFRAME_SANDBOX_ATTRIBUTE_VALUE = 'allow-same-origin allow-scripts';

const ObjectCtor = Object;
const TypeErrorCtor = TypeError;
const { prototype: DocumentProto } = Document;
const { prototype: NodeProto } = Node;
const { remove: ElementProtoRemove, setAttribute: ElementProtoSetAttribute } = Element.prototype;
const { appendChild: NodeProtoAppendChild } = NodeProto;
const { assign: ObjectAssign } = ObjectCtor;
// eslint-disable-next-line @typescript-eslint/naming-convention
const { __lookupGetter__: ObjectProto__lookupGetter__ } = ObjectCtor.prototype as any;
const { apply: ReflectApply } = Reflect;
const {
    close: DocumentProtoClose,
    createElement: DocumentProtoCreateElement,
    open: DocumentProtoOpen,
} = DocumentProto;
const DocumentProtoBodyGetter = ReflectApply(ObjectProto__lookupGetter__, DocumentProto, ['body'])!;
const HTMLElementProtoStyleGetter = ReflectApply(
    ObjectProto__lookupGetter__,
    HTMLElement.prototype,
    ['style']
)!;
const HTMLIFrameElementProtoContentWindowGetter = ReflectApply(
    ObjectProto__lookupGetter__,
    HTMLIFrameElement.prototype,
    ['contentWindow']
)!;
const NodeProtoLastChildGetter = ReflectApply(ObjectProto__lookupGetter__, NodeProto, [
    'lastChild',
])!;
const docRef = document;

interface BrowserEnvironmentOptions {
    distortionCallback?: DistortionCallback;
    endowments?: PropertyDescriptorMap;
    keepAlive?: boolean;
    instrumentation?: Instrumentation;
}

const createHooksCallback = createMembraneMarshall();

let defaultGlobalOwnKeys: (string | symbol)[] | null = null;

function createDetachableIframe(): HTMLIFrameElement {
    const iframe = ReflectApply(DocumentProtoCreateElement, docRef, [
        'iframe',
    ]) as HTMLIFrameElement;
    // It is impossible to test whether the NodeProtoLastChildGetter branch is
    // reached in a normal Karma test environment.
    const parent =
        ReflectApply(DocumentProtoBodyGetter, docRef, []) ||
        /* istanbul ignore next */ ReflectApply(NodeProtoLastChildGetter, docRef, []);
    const style = ReflectApply(HTMLElementProtoStyleGetter, iframe, []);
    style.display = 'none';
    ReflectApply(ElementProtoSetAttribute, iframe, ['sandbox', IFRAME_SANDBOX_ATTRIBUTE_VALUE]);
    ReflectApply(NodeProtoAppendChild, parent, [iframe]);
    return iframe;
}

interface BrowserEnvironmentOptions {
    distortionCallback?: DistortionCallback;
    endowments?: PropertyDescriptorMap;
    keepAlive?: boolean;
    instrumentation?: Instrumentation | undefined;
}

interface RealmController {
    cleanup: () => {};
    evaluator: typeof eval;
    getGlobalOwnKeys: () => (string | symbol)[];
    needsExplicitCleanUp: boolean;
}
// @ts-ignore: TypeScript doesn't know what a ShadowRealm is yet.
const { ShadowRealm: ShadowRealmCtor } = globalThis;
function createRealmController(options: BrowserEnvironmentOptions): RealmController {
    let cleanup = () => {};
    let evaluator: typeof eval;
    let getGlobalOwnKeys: () => (string | symbol)[];
    let needsExplicitCleanUp = false;

    if (typeof ShadowRealmCtor === 'function') {
        // @ts-ignore: TypeScript doesn't know what a ShadowRealm is yet.
        const shadowRealm = new ShadowRealm();
        evaluator = shadowRealm.evaluate.bind(shadowRealm);
        const getGlobalThisOwnKeysFromShadowRealm = evaluator(`(callableKeysCallback) => {
        let ownKeys = Reflect.ownKeys(globalThis);
        Reflect.apply(callableKeysCallback, undefined, ownKeys);
        };`);
        let keys: (string | symbol)[];
        getGlobalOwnKeys = () => {
            getGlobalThisOwnKeysFromShadowRealm((...args: (string | symbol)[]) => {
                keys = args;
            });
            return filterWindowKeys(filterGlobalOwnKeys(keys));
        };
    } else {
        const { keepAlive } = options;
        const iframe = createDetachableIframe();
        const redWindow = ReflectApply(
            HTMLIFrameElementProtoContentWindowGetter,
            iframe,
            []
        )!.window;
        getGlobalOwnKeys = () => filterWindowKeys(getFilteredGlobalOwnKeys(redWindow));
        const { document: redDocument } = redWindow;
        cleanup = () => {
            // Once we get the iframe info ready, and all mapped, we can proceed
            // to detach the iframe only if the keepAlive option isn't true.
            if (keepAlive) {
                // TODO: Temporary hack to preserve the document reference in Firefox.
                // https://bugzilla.mozilla.org/show_bug.cgi?id=543435
                ReflectApply(DocumentProtoOpen, redDocument, []);
                ReflectApply(DocumentProtoClose, redDocument, []);
            } else {
                ReflectApply(ElementProtoRemove, iframe, []);
            }
        };
        evaluator = redWindow.eval;
        needsExplicitCleanUp = true;
    }
    return {
        cleanup,
        evaluator,
        getGlobalOwnKeys,
        needsExplicitCleanUp,
    } as RealmController;
}

export default function createVirtualEnvironment(
    globalObjectShape: object | null,
    globalObjectVirtualizationTarget: WindowProxy & typeof globalThis,
    providedOptions?: BrowserEnvironmentOptions
): VirtualEnvironment {
    if (typeof globalObjectShape !== 'object') {
        throw new TypeErrorCtor('Missing global object shape.');
    }
    if (
        typeof globalObjectVirtualizationTarget !== 'object' ||
        globalObjectVirtualizationTarget === null
    ) {
        throw new TypeErrorCtor('Missing global object virtualization target.');
    }
    const options = ObjectAssign(
        {
            __proto__: null,
            keepAlive: false,
        },
        providedOptions
    );
    const {
        distortionCallback,
        endowments,
        instrumentation,
        keepAlive,
        // eslint-disable-next-line prefer-object-spread
    } = options;
    const realmController = createRealmController(options);
    let globalOwnKeys;
    if (globalObjectShape === null) {
        if (defaultGlobalOwnKeys === null) {
            defaultGlobalOwnKeys = realmController.getGlobalOwnKeys();
        }
        globalOwnKeys = defaultGlobalOwnKeys;
    } else {
        globalOwnKeys = filterWindowKeys(getFilteredGlobalOwnKeys(globalObjectShape));
    }
    // Chromium based browsers have a bug that nulls the result of `window`
    // getters in detached iframes when the property descriptor of `window.window`
    // is retrieved.
    // https://bugs.chromium.org/p/chromium/issues/detail?id=1305302
    const unforgeableGlobalThisKeys = keepAlive ? undefined : unforgeablePoisonedWindowKeys;
    const blueConnector = createHooksCallback;
    const redConnector = createConnector(realmController.evaluator);
    // Extract the global references and descriptors before any interference.
    const blueRefs = getCachedGlobalObjectReferences(globalObjectVirtualizationTarget);
    // Create a new environment.
    const env = new VirtualEnvironment({
        blueConnector,
        distortionCallback,
        redConnector,
        instrumentation,
    });
    linkIntrinsics(env, globalObjectVirtualizationTarget);
    // window
    // window.document
    // In browsers globalThis is === window.
    if (typeof globalThis === 'undefined') {
        // Support for globalThis was added in Chrome 71.
        // However, environments like Android emulators are running Chrome 69.
        env.link('window', 'document');
    } else {
        // document is === window.document.
        env.link('document');
    }
    // window.__proto__ (aka Window.prototype)
    // window.__proto__.__proto__ (aka WindowProperties.prototype)
    // window.__proto__.__proto__.__proto__ (aka EventTarget.prototype)
    env.link('__proto__', '__proto__', '__proto__');
    env.remapProto(blueRefs.document, blueRefs.DocumentProto);
    env.lazyRemap(blueRefs.window, globalOwnKeys, unforgeableGlobalThisKeys);
    if (endowments) {
        const filteredEndowments = {};
        assignFilteredGlobalDescriptorsFromPropertyDescriptorMap(filteredEndowments, endowments);
        removeWindowDescriptors(filteredEndowments);
        env.remap(blueRefs.window, filteredEndowments);
    }
    // We intentionally skip remapping Window.prototype because there is nothing
    // in it that needs to be remapped.
    env.lazyRemap(blueRefs.EventTargetProto, blueRefs.EventTargetProtoOwnKeys);
    if (realmController.needsExplicitCleanUp) {
        realmController.cleanup();
    }
    return env;
}
