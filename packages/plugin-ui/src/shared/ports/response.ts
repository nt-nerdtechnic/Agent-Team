/** Neutral response envelope shared by renderer capability ports. */
export interface PortError {
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface PortResponse<TPayload = unknown> {
  ok: boolean
  payload: TPayload | null
  error: PortError | null
}
