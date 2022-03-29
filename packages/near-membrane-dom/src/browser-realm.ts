import {
    assignFilteredGlobalDescriptorsFromPropertyDescriptorMap,
    CallableEvaluate,
    createConnector,
    createMembraneMarshall,
    getFilteredGlobalOwnKeys,
    linkIntrinsics,
    DistortionCallback,
    Instrumentation,
    Pointer,
    PropertyKeys,
    SUPPORTS_SHADOW_REALM,
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
const { bind: FunctionProtoBind } = Function.prototype;
const { prototype: NodeProto } = Node;
const { remove: ElementProtoRemove, setAttribute: ElementProtoSetAttribute } = Element.prototype;
const { appendChild: NodeProtoAppendChild } = NodeProto;
const { assign: ObjectAssign, getOwnPropertyDescriptors: ObjectGetOwnPropertyDescriptors } =
    ObjectCtor;
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
// @ts-ignore
const ShadowRealmCtor = SUPPORTS_SHADOW_REALM ? ShadowRealm : undefined;
const ShadowRealmProtoEvaluate: CallableEvaluate | undefined = ShadowRealmCtor?.prototype?.evaluate;
const docRef = document;

interface BrowserEnvironmentOptions {
    distortionCallback?: DistortionCallback;
    endowments?: PropertyDescriptorMap;
    keepAlive?: boolean;
    instrumentation?: Instrumentation;
}

const createHooksCallback = createMembraneMarshall();
const defaultGlobalOwnKeysRegistry = { __proto__: null };

let defaultGlobalOwnKeys: PropertyKeys | null = null;
let defaultGlobalPropertyDescriptorMap: PropertyDescriptorMap | null = null;

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

function createIframeVirtualEnvironment(
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
    const {
        distortionCallback,
        endowments,
        instrumentation,
        keepAlive = false,
        // eslint-disable-next-line prefer-object-spread
    } = ObjectAssign({ __proto__: null }, providedOptions);

    const blueConnector = createHooksCallback;

    let filteredEndowments: PropertyDescriptorMap | undefined;

    if (endowments) {
        filteredEndowments = {};
        assignFilteredGlobalDescriptorsFromPropertyDescriptorMap(filteredEndowments, endowments);
        removeWindowDescriptors(filteredEndowments);
    }
    const iframe = createDetachableIframe();
    const redWindow: Window & typeof globalThis = ReflectApply(
        HTMLIFrameElementProtoContentWindowGetter,
        iframe,
        []
    )!;
    if (globalObjectShape === null && defaultGlobalOwnKeys === null) {
        defaultGlobalOwnKeys = filterWindowKeys(getFilteredGlobalOwnKeys(redWindow));
    }
    const redDocument = redWindow.document;
    const redConnector: typeof createHooksCallback = createConnector(redWindow.eval);

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
    env.remapProto(blueRefs.document, blueRefs.DocumentProto!);
    env.lazyRemap(
        blueRefs.window,
        globalObjectShape === null
            ? (defaultGlobalOwnKeys as PropertyKeys)
            : filterWindowKeys(getFilteredGlobalOwnKeys(globalObjectShape)),
        // Chromium based browsers have a bug that nulls the result of `window`
        // getters in detached iframes when the property descriptor of `window.window`
        // is retrieved.
        // https://bugs.chromium.org/p/chromium/issues/detail?id=1305302
        keepAlive ? undefined : unforgeablePoisonedWindowKeys
    );
    if (endowments) {
        env.remap(blueRefs.window, filteredEndowments!);
    }
    // We intentionally skip remapping Window.prototype because there is nothing
    // in it that needs to be remapped.
    env.lazyRemap(blueRefs.EventTargetProto!, blueRefs.EventTargetProtoOwnKeys!);
    // We don't remap `blueRefs.WindowPropertiesProto` because it is "magical"
    // in that it provides access to elements by id.
    //
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
    return env;
}

function createShadowRealmVirtualEnvironment(
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
    const {
        distortionCallback,
        endowments,
        instrumentation,
        // eslint-disable-next-line prefer-object-spread
    } = ObjectAssign({ __proto__: null }, providedOptions);

    const blueConnector = createHooksCallback;

    let filteredEndowments: PropertyDescriptorMap | undefined;

    if (endowments) {
        filteredEndowments = {};
        assignFilteredGlobalDescriptorsFromPropertyDescriptorMap(filteredEndowments, endowments);
        removeWindowDescriptors(filteredEndowments);
    }
    if (defaultGlobalPropertyDescriptorMap === null) {
        const oneTimeIframe = createDetachableIframe();
        const oneTimeWindow = ReflectApply(
            HTMLIFrameElementProtoContentWindowGetter,
            oneTimeIframe,
            []
        )!;
        defaultGlobalOwnKeys = getFilteredGlobalOwnKeys(oneTimeWindow);
        ReflectApply(ElementProtoRemove, oneTimeIframe, []);
        defaultGlobalPropertyDescriptorMap = {
            __proto__: null,
        } as unknown as PropertyDescriptorMap;
        assignFilteredGlobalDescriptorsFromPropertyDescriptorMap(
            defaultGlobalPropertyDescriptorMap,
            ObjectGetOwnPropertyDescriptors(window)
        );
        for (let i = 0, { length } = defaultGlobalOwnKeys; i < length; i += 1) {
            defaultGlobalOwnKeysRegistry[defaultGlobalOwnKeys[i]] = true;
        }
        for (const key in defaultGlobalPropertyDescriptorMap) {
            if (!(key in defaultGlobalOwnKeysRegistry)) {
                delete defaultGlobalPropertyDescriptorMap[key];
            }
        }
    }
    const redConnector = createConnector(
        ReflectApply(FunctionProtoBind, ShadowRealmProtoEvaluate, [new ShadowRealmCtor()])
    );

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

    let unsafeBlueDescMap: PropertyDescriptorMap;
    if (globalObjectVirtualizationTarget === window) {
        unsafeBlueDescMap = defaultGlobalPropertyDescriptorMap!;
    } else {
        unsafeBlueDescMap = { __proto__: null } as unknown as PropertyDescriptorMap;
        assignFilteredGlobalDescriptorsFromPropertyDescriptorMap(
            unsafeBlueDescMap,
            ObjectGetOwnPropertyDescriptors(globalObjectVirtualizationTarget)
        );
        for (const key in unsafeBlueDescMap) {
            if (!(key in defaultGlobalOwnKeysRegistry)) {
                delete unsafeBlueDescMap[key];
            }
        }
    }
    env.link('globalThis');
    env.redCallableSetPrototypeOf(
        env.redGlobalThisPointer as Pointer,
        env.blueGetTransferableValue(blueRefs.WindowProto) as Pointer
    );
    env.remap(blueRefs.window, unsafeBlueDescMap);
    if (endowments) {
        env.remap(blueRefs.window, filteredEndowments!);
    }
    return env;
}

export default SUPPORTS_SHADOW_REALM
    ? createShadowRealmVirtualEnvironment
    : createIframeVirtualEnvironment;
