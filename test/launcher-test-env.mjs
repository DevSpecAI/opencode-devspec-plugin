// Unit tests may instantiate the real plugin factory. Do not register services
// or alter the developer's OS; actual install verification uses isolated profiles.
process.env.DEVSPEC_LAUNCHER_DISABLED = '1'
