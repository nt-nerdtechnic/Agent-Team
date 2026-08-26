import { runGitTransportContract } from './gitTransport.contract'
import { createInMemoryGitTransport } from './inMemoryGitTransport'

runGitTransportContract(() => createInMemoryGitTransport({ value: 'connected' }))
