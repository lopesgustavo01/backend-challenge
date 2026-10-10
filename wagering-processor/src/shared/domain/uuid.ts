const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Um id malformado nunca existe: consultas respondem "não encontrado" em vez de deixar o Postgres rejeitar o cast. */
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
