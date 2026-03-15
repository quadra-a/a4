export class QuadraAError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'QuadraAError';
  }
}

export class IdentityError extends QuadraAError {
  constructor(message: string, details?: unknown) {
    super(message, 'IDENTITY_ERROR', details);
    this.name = 'IdentityError';
  }
}

export class TransportError extends QuadraAError {
  constructor(message: string, details?: unknown) {
    super(message, 'TRANSPORT_ERROR', details);
    this.name = 'TransportError';
  }
}

export class DiscoveryError extends QuadraAError {
  constructor(message: string, details?: unknown) {
    super(message, 'DISCOVERY_ERROR', details);
    this.name = 'DiscoveryError';
  }
}

export class MessagingError extends QuadraAError {
  constructor(message: string, details?: unknown) {
    super(message, 'MESSAGING_ERROR', details);
    this.name = 'MessagingError';
  }
}

export class EncryptionError extends QuadraAError {
  constructor(message: string, details?: unknown) {
    super(message, 'ENCRYPTION_ERROR', details);
    this.name = 'EncryptionError';
  }
}
