export class InstalledPluginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstalledPluginError'
  }
}
