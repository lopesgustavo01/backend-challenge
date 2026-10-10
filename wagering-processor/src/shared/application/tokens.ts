/** Tokens de injeção das portas (Bun não emite design:paramtypes, então a DI é sempre por token explícito). */
export const CLOCK = Symbol("CLOCK");
export const ID_GENERATOR = Symbol("ID_GENERATOR");
export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
export const LOGGER = Symbol("LOGGER");
export const METRICS = Symbol("METRICS");
export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");
