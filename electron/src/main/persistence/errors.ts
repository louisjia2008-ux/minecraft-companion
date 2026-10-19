export class PersistenceCorruptionError extends Error {
  readonly quarantinedPath: string;

  constructor(message: string, quarantinedPath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PersistenceCorruptionError';
    this.quarantinedPath = quarantinedPath;
  }
}

export class UnsupportedSchemaVersionError extends Error {
  readonly foundVersion: number;
  readonly supportedVersion: number;

  constructor(foundVersion: number, supportedVersion: number) {
    super(`Unsupported schema version ${foundVersion}; this build supports ${supportedVersion}.`);
    this.name = 'UnsupportedSchemaVersionError';
    this.foundVersion = foundVersion;
    this.supportedVersion = supportedVersion;
  }
}
