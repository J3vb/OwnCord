package safefetch

import "errors"

// The refusal vocabulary. Every one of these is a policy decision, not a
// transport failure: a caller that wants to tell "the destination is not
// allowed" from "the destination did not answer" tests with errors.Is against
// these and treats anything else as an upstream problem.
var (
	// ErrInvalidURL — the URL did not parse, or carried no host.
	ErrInvalidURL = errors.New("safefetch: invalid URL")
	// ErrBlockedScheme — the URL's scheme is not in Policy.Schemes.
	ErrBlockedScheme = errors.New("safefetch: scheme not allowed")
	// ErrBlockedPort — the URL's port is not in Policy.Ports.
	ErrBlockedPort = errors.New("safefetch: port not allowed")
	// ErrCredentialsInURL — the URL carried userinfo. Credentials in a URL
	// are how a fetch is tricked into authenticating to somewhere it should
	// not, and no caller here has a use for them.
	ErrCredentialsInURL = errors.New("safefetch: URL carries embedded credentials")
	// ErrHostNotAllowed — the caller's own Request.AllowHost rule refused
	// this hop's host. Distinct from ErrBlockedAddress: the address may be
	// perfectly routable, and the caller simply does not permit that host.
	ErrHostNotAllowed = errors.New("safefetch: host not allowed by the caller's rule")
	// ErrBlockedAddress — a resolved address is not globally routable.
	ErrBlockedAddress = errors.New("safefetch: destination address is not globally routable")
	// ErrResolve — the hostname did not resolve.
	ErrResolve = errors.New("safefetch: cannot resolve host")
	// ErrNoAddresses — the hostname resolved to an empty answer set.
	ErrNoAddresses = errors.New("safefetch: host resolved to no addresses")
	// ErrTooManyRedirects — the hop budget ran out. A redirect loop lands here.
	ErrTooManyRedirects = errors.New("safefetch: too many redirects")
	// ErrSchemeDowngrade — a redirect moved from https to a weaker scheme.
	ErrSchemeDowngrade = errors.New("safefetch: redirect downgrades the scheme")
	// ErrRedirectWithoutLocation — a 3xx with no usable Location header.
	ErrRedirectWithoutLocation = errors.New("safefetch: redirect without a usable Location")
	// ErrBodyTooLarge — the response exceeded Policy.MaxBytes on the wire.
	ErrBodyTooLarge = errors.New("safefetch: response body exceeds the byte ceiling")
	// ErrDecompressedTooLarge — the response inflated past
	// Policy.MaxDecompressedBytes. A body that is small on the wire and huge
	// after inflation is the whole point of this being a separate ceiling.
	ErrDecompressedTooLarge = errors.New("safefetch: decompressed body exceeds the byte ceiling")
	// ErrContentEncoding — the body arrived in an encoding we neither asked
	// for nor decode. Returning those bytes as content, with or without the
	// header, describes a body that does not exist.
	ErrContentEncoding = errors.New("safefetch: unsupported content encoding")
	// ErrContentType — the declared or the sniffed media type is not allowed.
	ErrContentType = errors.New("safefetch: content type not allowed")
	// ErrPolicy — the Policy itself is unusable.
	ErrPolicy = errors.New("safefetch: invalid policy")
)
