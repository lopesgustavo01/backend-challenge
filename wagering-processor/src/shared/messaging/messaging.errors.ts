import { DomainError } from "@/shared/domain/errors";

export class InvalidMessageStateError extends DomainError {
  readonly code = "INVALID_MESSAGE_STATE";
}
