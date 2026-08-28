/**
 * Package-local frontend entry boundary.
 *
 * The package owns this composition entry and its adapter modules. Shared Git
 * UI/domain code is consumed through explicit build aliases, so the production
 * bundle does not execute the legacy plugin mount or legacy bundle entry.
 */
import './mount'
