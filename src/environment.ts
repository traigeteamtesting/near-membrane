import { apply, isUndefined, ObjectCreate, isFunction, hasOwnProperty, ObjectDefineProperty, emptyArray, isArray, map, construct, ESGlobalKeys, getOwnPropertyDescriptor, isExtensible } from './shared';
import { SecureProxyHandler } from './secure-proxy-handler';
import { ReverseProxyHandler } from './reverse-proxy-handler';

/**
 * This method returns a descriptor that given an original setter, and a getter, can use the original
 * getter to return a secure object, but if the sandbox attempts to set it to a new value, this
 * mutation will only affect the sandbox's global object, and the getter will start returning the
 * new provided value rather than calling onto the outer realm. This is to preserve the object graph
 * of the outer realm.
 */
function getSecureGlobalAccessorDescriptor(env: SecureEnvironment, descriptor: PropertyDescriptor): PropertyDescriptor {
    const { get: originalGetter } = descriptor;
    let currentGetter = isUndefined(originalGetter) ? () => undefined : function(this: any): SecureValue {
        const value: RawValue = apply(originalGetter, env.getRawValue(this), emptyArray);
        return env.getSecureValue(value);
    }
    if (!isUndefined(originalGetter)) {
        descriptor.get = function get(): SecureValue {
            return apply(currentGetter, this, emptyArray);
        };
    }
    descriptor.set = function set(v: SecureValue): void {
        // if a global setter is invoke, the value will be use as it is as the result of the getter operation
        currentGetter = () => v;
    };
    return descriptor;
}

export type RawValue = any;
export type RawArray = RawValue[];
export type RawFunction = (...args: RawValue[]) => RawValue;
export type RawObject = object;
export interface RawConstructor {
    new(...args: any[]): RawObject;
}
export type SecureProxyTarget = RawObject | RawFunction | RawConstructor;
export type ReverseProxyTarget = SecureObject | SecureFunction | SecureConstructor;
// TODO: how to doc the ProxyOf<>
export type SecureShadowTarget = SecureProxyTarget; // Proxy<SecureProxyTarget>;
export type ReverseShadowTarget = ReverseProxyTarget; // Proxy<ReverseProxyTarget>;

type SecureProxy = SecureObject | SecureFunction;
type ReverseProxy = RawObject | RawFunction;

export type SecureValue = any;
export type SecureFunction = (...args: SecureValue[]) => SecureValue;
export type SecureArray = SecureValue[];
export type SecureObject = object;
export interface SecureConstructor {
    new(...args: any[]): SecureObject;
}
interface SecureRecord {
    raw: SecureProxyTarget;
    sec: SecureProxy;
}

// it means it does have identity and should be proxified.
function isProxyTarget(o: RawValue | SecureValue):
    o is (RawFunction | RawConstructor | RawObject | SecureFunction | SecureConstructor | SecureObject) {
    // hire-wired for the common case
    if (o == null) {
        return false;
    }
    const t = typeof o;
    return t === 'object' || t === 'function';
}

interface SecureEnvironmentOptions {
    // Base global object used by the raw environment
    rawGlobalThis: any;
    // Secure global object used by the secure environment
    secureGlobalThis: any;
    // Optional distortion hook to prevent access to certain capabilities from within the secure environment
    distortionCallback?: (target: SecureProxyTarget) => SecureProxyTarget;
}

export class SecureEnvironment {
    // secure global object
    private secureGlobalThis: any;
    // secure object map
    private som: WeakMap<SecureFunction | SecureObject, SecureRecord> = new WeakMap();
    // raw object map
    private rom: WeakMap<RawFunction | RawObject, SecureRecord> = new WeakMap();
    // distortion mechanism (default to noop)
    private distortionCallback?: (target: SecureProxyTarget) => SecureProxyTarget = t => t;

    constructor(options: SecureEnvironmentOptions) {
        if (isUndefined(options)) {
            throw new Error(`Missing SecureEnvironmentOptions options bag.`);
        }
        const { rawGlobalThis, secureGlobalThis, distortionCallback } = options;
        this.distortionCallback = distortionCallback;
        this.secureGlobalThis = secureGlobalThis;
        // These are foundational things that should never be wrapped but are equivalent
        // TODO: revisit this, is this really needed? what happen if Object.prototype is patched in the sec env?
        this.createSecureRecord(secureGlobalThis.Object, rawGlobalThis.Object);
        this.createSecureRecord(secureGlobalThis.Object.prototype, rawGlobalThis.Object.prototype);
        this.createSecureRecord(secureGlobalThis.Function, rawGlobalThis.Function);
        this.createSecureRecord(secureGlobalThis.Function.prototype, rawGlobalThis.Function.prototype);
    }

    private createSecureShadowTarget(o: SecureProxyTarget): SecureShadowTarget {
        let shadowTarget: SecureShadowTarget;
        if (isFunction(o)) {
            shadowTarget = function () {};
            ObjectDefineProperty(shadowTarget, 'name', {
                value: o.name,
                configurable: true,
            });
        } else {
            // o is object
            shadowTarget = {};
        }
        return shadowTarget;
    }
    private createReverseShadowTarget(o: SecureProxyTarget | ReverseProxyTarget): ReverseShadowTarget {
        let shadowTarget: ReverseShadowTarget;
        if (isFunction(o)) {
            shadowTarget = function () {};
            ObjectDefineProperty(shadowTarget, 'name', {
                value: o.name,
                configurable: true,
            });
        } else {
            // o is object
            shadowTarget = {};
        }
        return shadowTarget;
    }
    private createSecureProxy(raw: SecureProxyTarget): SecureProxy {
        const shadowTarget = this.createSecureShadowTarget(raw);
        const proxyHandler = new SecureProxyHandler(this, raw);
        const sec = new Proxy(shadowTarget, proxyHandler);
        this.createSecureRecord(sec, raw);
        return sec;
    }
    private createReverseProxy(sec: ReverseProxyTarget): ReverseProxy {
        const shadowTarget = this.createReverseShadowTarget(sec);
        const proxyHandler = new ReverseProxyHandler(this, sec);
        const raw = new Proxy(shadowTarget, proxyHandler);
        this.createSecureRecord(sec, raw);
        // eager initialization of reverse proxies
        proxyHandler.initialize(shadowTarget);
        return raw;
    }
    private createSecureRecord(sec: SecureObject, raw: RawObject) {
        const sr: SecureRecord = ObjectCreate(null);
        sr.raw = raw;
        sr.sec = sec;
        // double index for perf
        this.som.set(sec, sr);
        this.rom.set(raw, sr);
    }
    private getDistortedValue(target: SecureProxyTarget): SecureProxyTarget {
        const { distortionCallback } = this;
        if (isUndefined(distortionCallback)) {
            return target;
        }
        const distortedTarget = distortionCallback(target);
        if (!isProxyTarget(distortedTarget)) {
            throw new Error(`Invalid distortion mechanism.`);
        }
        return distortedTarget;
    }

    remap(secureValue: SecureValue, rawValue: RawValue, rawDescriptors: PropertyDescriptorMap) {
        this.createSecureRecord(secureValue, rawValue);
        for (const key in rawDescriptors) {
            // TODO: this whole block needs cleanup and simplification
            // avoid overriding ecma script global keys.
            if (!ESGlobalKeys.has(key)) {
                const secureDescriptor = getOwnPropertyDescriptor(secureValue, key);
                if (hasOwnProperty(rawDescriptors, key)) {
                    // avoid poisoning to only installing own properties from baseDescriptors,
                    let rawDescriptor = rawDescriptors[key];
                    if (hasOwnProperty(rawDescriptor, 'set')) {
                        // setter, and probably getter branch
                        rawDescriptor = getSecureGlobalAccessorDescriptor(this, rawDescriptor);
                    } else if (hasOwnProperty(rawDescriptor, 'get')) {
                        // getter only branch (e.g.: window.navigator)
                        const { get: originalGetter } = rawDescriptor;
                        const env = this;
                        rawDescriptor.get = function get(): SecureValue {
                            const value: RawValue = apply(originalGetter as () => any, env.getRawValue(this), emptyArray);
                            return env.getSecureValue(value);
                        };
                    } else {
                        // value branch
                        const { value: rawDescriptorValue } = rawDescriptor;
                        // TODO: maybe we should make everything a getter/setter that way
                        // we don't pay the cost of creating the proxy in the first place
                        rawDescriptor.value = this.getSecureValue(rawDescriptorValue);
                    }
                    if (!isUndefined(secureDescriptor) && 
                            hasOwnProperty(secureDescriptor, 'configurable') &&  
                            secureDescriptor.configurable === false) {
                        // this is the case where the secure env has a descriptor that was supposed to be
                        // overrule but can't be done because it is a non-configurable. Instead we try to
                        // fallback to some more advanced gymnastics
                        if (hasOwnProperty(secureDescriptor, 'value') && isProxyTarget(secureDescriptor.value)) {
                            const { value: secureDescriptorValue } = secureDescriptor;
                            if (!this.som.has(secureDescriptorValue)) {
                                // remapping the value of the secure object graph to the outer realm graph
                                const { value: rawDescriptorValue } = rawDescriptor;
                                if (secureValue !== rawDescriptorValue) {
                                    if (this.getRawValue(secureValue) !== rawValue) {
                                        console.error('need remapping: ',  key, rawValue, rawDescriptor);
                                    } else {
                                        // it was already mapped
                                    }
                                } else {
                                    // window.top is the classic example of a descriptor that leaks access to the outer
                                    // window reference, and there is no containment for that case yet.
                                    console.error('leaking: ',  key, rawValue, rawDescriptor);
                                }
                            } else {
                                // an example of this is circular window.window ref
                                console.info('circular: ',  key, rawValue, rawDescriptor);
                            }
                        } else if (hasOwnProperty(secureDescriptor, 'get') && isProxyTarget(secureValue[key])) {
                            const secureDescriptorValue = secureValue[key];
                            if (secureDescriptorValue === secureValue[key]) {
                                // this is the case for window.document which is identity preserving getter
                                // const rawDescriptorValue = rawValue[key];
                                // this.createSecureRecord(secureDescriptorValue, rawDescriptorValue);
                                // this.installDescriptors(secureDescriptorValue, rawDescriptorValue, getOwnPropertyDescriptors(rawDescriptorValue));
                                console.error('need remapping: ', key, rawValue, rawDescriptor);
                                if (isExtensible(secureDescriptorValue)) {
                                    // remapping proto chain
                                    // setPrototypeOf(secureDescriptorValue, this.getSecureValue(getPrototypeOf(secureDescriptorValue)));
                                    console.error('needs prototype remapping: ', rawValue);
                                } else {
                                    console.error('leaking prototype: ',  key, rawValue, rawDescriptor);
                                }
                            } else {
                                console.error('leaking a getter returning values without identity: ', key, rawValue, rawDescriptor);
                            }
                        } else {
                            console.error('skipping: ', key, rawValue, rawDescriptor);
                        }
                    } else {
                        ObjectDefineProperty(secureValue, key, rawDescriptor);
                    }
                }
            }
        }
    }

    // membrane operations
    getSecureValue(raw: RawValue): SecureValue {
        if (isArray(raw)) {
            return this.getSecureArray(raw);
        } else if (isProxyTarget(raw)) {
            let sr = this.rom.get(raw);
            if (isUndefined(sr)) {
                return this.createSecureProxy(this.getDistortedValue(raw));
            }
            return sr.sec;
        } else {
            return raw as SecureValue;
        }
    }
    getSecureArray(a: RawArray): SecureArray {
        // identity of the new array correspond to the inner realm
        const SecureArray = this.secureGlobalThis.Array as ArrayConstructor;
        const b: SecureValue[] = map(a, (raw: RawValue) => this.getSecureValue(raw));
        return construct(SecureArray, b);
    }
    getSecureFunction(fn: RawFunction): SecureFunction {
        let sr = this.rom.get(fn);
        if (isUndefined(sr)) {
            return this.createSecureProxy(this.getDistortedValue(fn)) as SecureFunction;
        }
        return sr.sec as SecureFunction;
    }
    getRawValue(sec: SecureValue): RawValue {
        if (isArray(sec)) {
            return this.getRawArray(sec);
        } else if (isProxyTarget(sec)) {
            let sr = this.som.get(sec);
            if (isUndefined(sr)) {
                return this.createReverseProxy(sec);
            }
            return sr.raw;
        }
        return sec as RawValue;
    }
    getRawFunction(fn: SecureFunction): RawFunction {
        let sr = this.som.get(fn);
        if (isUndefined(sr)) {
            return this.createReverseProxy(fn) as RawFunction;
        }
        return sr.raw as SecureFunction;
    }
    getRawArray(a: SecureArray): RawArray {
        // identity of the new array correspond to the outer realm
        return map(a, (sec: SecureValue) => this.getRawValue(sec));
    }
    get globalThis(): RawValue {
        return this.secureGlobalThis;
    }
}