/**
 * Relation handles live only inside one shape callback, so they are not frozen:
 * freezing a function with many properties costs more than building it.
 */
export const callable = <Arguments extends unknown[]>(
  invoke: (...argumentsList: Arguments) => unknown,
  properties: object,
  relatedColumns = false,
): object => {
  if (relatedColumns) {
    // Accessor descriptors let a relation Proxy expose columns named name/length.
    Object.defineProperties(invoke, {
      name: { get: () => undefined },
      length: { get: () => undefined },
    });
  }

  return Object.assign(invoke, properties);
};

/** Lazy binding preserves detached calls without allocating every method per query. */
export const boundMethodDescriptors = (
  methods: object,
): PropertyDescriptorMap => {
  const descriptors = Object.getOwnPropertyDescriptors(methods);

  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors]!;

    if (typeof descriptor.value !== "function") {
      continue;
    }

    const method = descriptor.value as (...argumentsList: unknown[]) => unknown;
    const bound = new WeakMap<object, typeof method>();
    descriptors[key as keyof typeof descriptors] = {
      enumerable: !!descriptor.enumerable,
      configurable: !!descriptor.configurable,
      get(this: object) {
        let value = bound.get(this);

        if (!value) {
          value = method.bind(this);
          bound.set(this, value);
        }

        return value;
      },
    };
  }

  return descriptors;
};

export const extendBuilder = (builder: object, properties: object): object => {
  if (typeof builder === "function") {
    const extended = (...argumentsList: unknown[]) =>
      Reflect.apply(builder, undefined, argumentsList);

    // Inherit prototype methods and carry over own state, including symbol keys.
    Object.setPrototypeOf(extended, Object.getPrototypeOf(builder));

    for (const key of Reflect.ownKeys(builder)) {
      if (key !== "length" && key !== "name") {
        Object.defineProperty(extended, key, {
          ...Object.getOwnPropertyDescriptor(builder, key)!,
          configurable: true,
        });
      }
    }

    for (const key of Reflect.ownKeys(properties)) {
      Object.defineProperty(extended, key, {
        value: (properties as Record<PropertyKey, unknown>)[key],
        enumerable: true,
        configurable: true,
      });
    }

    return Object.freeze(extended);
  }

  return Object.freeze({ ...builder, ...properties });
};
