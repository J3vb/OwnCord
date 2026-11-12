package externalcontent

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/J3vb/OwnCord/Server/safefetch"
	"golang.org/x/sync/singleflight"
)

// Failure is why the broker refused or failed; the values are the client contract's spellings.
type Failure string

const (
	BlockedDestination Failure = "blocked-destination"
	TooManyRedirects   Failure = "too-many-redirects"
	Oversized          Failure = "oversized"
	WrongType          Failure = "wrong-type"
	ExpiredHandle      Failure = "expired-handle"
	Unavailable        Failure = "unavailable"
)

// Error carries a Failure through an error return; transient marks one that says nothing about the
// destination (no fetch slot came free), so it is never remembered.
type Error struct {
	Failure   Failure
	transient bool
}

func (e *Error) Error() string { return "externalcontent: " + string(e.Failure) }

func fail(f Failure) error { return &Error{Failure: f} }

// FailureOf is the Failure an error stands for; anything else is Unavailable.
func FailureOf(err error) Failure {
	if e, ok := errors.AsType[*Error](err); ok {
		return e.Failure
	}
	return Unavailable
}

// Limits match the desktop broker's (external_content.rs, Limits::PRODUCTION),
// except the image deadline, which stays under the REST request deadline.
const (
	pageBytes     = 64 << 10
	pageWireBytes = 256 << 10
	imageBytes    = 16 << 20
	pageDeadline  = 5 * time.Second
	imageDeadline = 12 * time.Second
	maxRedirects  = 3
	maxConcurrent = 6
	cacheBytes    = 64 << 20
	cacheTTL      = time.Hour
	// failureTTL is how long a failed fetch is answered from cache, so a dead host costs one fetch per
	// five minutes, not one per viewer per render.
	failureTTL = 5 * time.Minute
	// failureEntryBytes is a remembered failure's cache weight beside its key.
	failureEntryBytes = 64
	// handlesPerUser is how many preview image handles one member holds.
	handlesPerUser = 256
	// maxURLBytes bounds any URL the broker is asked for or mints a handle for.
	maxURLBytes = 2048
)

// userAgent is the crawler token sites match on for Open Graph markup; it carries no version.
const userAgent = "facebookexternalhit/1.1"

// imageTypes are the raster types an image fetch may return. SVG is absent because it can carry
// script; AVIF because the sniffer cannot recognise it, so its declared type could not be checked.
var imageTypes = []string{"image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"}

// DefaultPagePolicy and DefaultImagePolicy are the production fetch policies. Pages are read to
// their first 64 KiB, where <head> lives; an oEmbed document past that fails to parse.
var (
	DefaultPagePolicy = safefetch.Policy{
		Schemes:              []string{"https"},
		Ports:                []int{443},
		ContentTypes:         []string{"text/html", "application/xhtml+xml", "application/json", "text/plain"},
		MaxRedirects:         maxRedirects,
		Deadline:             pageDeadline,
		MaxBytes:             pageWireBytes,
		MaxDecompressedBytes: pageBytes,
		MaxConcurrent:        maxConcurrent,
		Truncate:             true,
	}
	DefaultImagePolicy = safefetch.Policy{
		Schemes:              []string{"https"},
		Ports:                []int{443},
		ContentTypes:         imageTypes,
		MaxRedirects:         maxRedirects,
		Deadline:             imageDeadline,
		MaxBytes:             imageBytes,
		MaxDecompressedBytes: imageBytes,
		MaxConcurrent:        maxConcurrent,
	}
)

// Preview is the typed minimum a page reduces to; Image is an opaque handle fetchable only by its user.
type Preview struct {
	Title       *string `json:"title"`
	Description *string `json:"description"`
	SiteName    *string `json:"site_name"`
	Image       *string `json:"image"`
	ImageWidth  *uint32 `json:"image_width,omitempty"`
	ImageHeight *uint32 `json:"image_height,omitempty"`
}

// Broker fetches previews and images under the policies above; safe for concurrent use.
type Broker struct {
	page    *safefetch.Fetcher
	image   *safefetch.Fetcher
	cache   *resultCache
	handles *handleTable
	flight  singleflight.Group
}

// New builds a broker from two fetch policies; tests pass ones that can reach a loopback stub.
func New(page, image safefetch.Policy) (*Broker, error) {
	pf, err := safefetch.New(page)
	if err != nil {
		return nil, fmt.Errorf("externalcontent: page policy: %w", err)
	}
	imf, err := safefetch.New(image)
	if err != nil {
		return nil, fmt.Errorf("externalcontent: image policy: %w", err)
	}
	return &Broker{
		page:    pf,
		image:   imf,
		cache:   newResultCache(cacheBytes, cacheTTL),
		handles: newHandleTable(handlesPerUser),
	}, nil
}

// MustNew is New for compile-time policies: a refused one is a programming error, so it panics
// rather than return an unbounded broker.
func MustNew(page, image safefetch.Policy) *Broker {
	b, err := New(page, image)
	if err != nil {
		panic(err)
	}
	return b
}

// Preview fetches rawURL and reduces it to its preview: Open Graph for an
// HTML page, the title for an oEmbed document.
func (b *Broker) Preview(ctx context.Context, owner int64, rawURL string) (Preview, error) {
	if len(rawURL) > maxURLBytes {
		return Preview{}, fail(BlockedDestination)
	}
	key := "preview:" + rawURL
	data, err := b.cachedPreview(ctx, key, rawURL)
	if err != nil {
		return Preview{}, err
	}
	out := Preview{
		Title:       data.Title,
		Description: data.Description,
		SiteName:    data.SiteName,
		ImageWidth:  data.ImageWidth,
		ImageHeight: data.ImageHeight,
	}
	if data.ImageURL != "" {
		id, mintErr := b.handles.mint(owner, data.ImageURL)
		if mintErr != nil {
			return Preview{}, fmt.Errorf("externalcontent: mint handle: %w", mintErr)
		}
		out.Image = &id
	}
	return out, nil
}

func (b *Broker) cachedPreview(ctx context.Context, key, rawURL string) (previewData, error) {
	if entry, ok := b.cache.get(key); ok {
		if entry.failure != "" {
			return previewData{}, fail(entry.failure)
		}
		return entry.preview, nil
	}
	v, err, _ := b.flight.Do(key, func() (any, error) {
		resp, fetchErr := b.fetch(ctx, b.page, rawURL, "text/html, application/json;q=0.9")
		if fetchErr != nil {
			return nil, b.rememberFailure(key, fetchErr)
		}
		data, reduceErr := reducePage(resp)
		if reduceErr != nil {
			return nil, b.rememberFailure(key, reduceErr)
		}
		b.cache.put(&cacheEntry{key: key, preview: data, size: data.size()})
		return data, nil
	})
	if err != nil {
		return previewData{}, err
	}
	data, _ := v.(previewData)
	return data, nil
}

// Image fetches one image, named by a handle from Preview or by a URL the
// caller already holds, and returns its bytes and media type.
func (b *Broker) Image(ctx context.Context, owner int64, handleID, rawURL string) ([]byte, string, error) {
	var target string
	switch {
	case handleID != "" && rawURL == "":
		found, ok := b.handles.lookup(owner, handleID)
		if !ok {
			return nil, "", fail(ExpiredHandle)
		}
		target = found
	case handleID == "" && rawURL != "":
		target = rawURL
	default:
		return nil, "", fail(BlockedDestination)
	}
	if len(target) > maxURLBytes {
		return nil, "", fail(BlockedDestination)
	}
	key := "image:" + target
	if entry, ok := b.cache.get(key); ok {
		if entry.failure != "" {
			return nil, "", fail(entry.failure)
		}
		return entry.image, entry.media, nil
	}
	v, err, _ := b.flight.Do(key, func() (any, error) {
		resp, fetchErr := b.fetch(ctx, b.image, target, "image/*")
		if fetchErr != nil {
			return nil, b.rememberFailure(key, fetchErr)
		}
		media := sniffImage(resp.Body)
		if media == "" || media != resp.ContentType {
			// The declared type is only a claim: the bytes have to agree.
			return nil, b.rememberFailure(key, fail(WrongType))
		}
		entry := &cacheEntry{key: key, image: resp.Body, media: media, size: int64(len(resp.Body))}
		b.cache.put(entry)
		return entry, nil
	})
	if err != nil {
		return nil, "", err
	}
	entry, _ := v.(*cacheEntry)
	return entry.image, entry.media, nil
}

// rememberFailure keeps a failed fetch for failureTTL and returns err. Refused destinations and
// fetches that never started for want of a slot are not kept.
func (b *Broker) rememberFailure(key string, err error) error {
	e, ok := errors.AsType[*Error](err)
	if !ok || e.transient {
		return err
	}
	switch e.Failure {
	case TooManyRedirects, Oversized, WrongType, Unavailable:
		b.cache.putFor(&cacheEntry{key: key, failure: e.Failure, size: int64(len(key)) + failureEntryBytes}, failureTTL)
	case BlockedDestination, ExpiredHandle:
	}
	return err
}

// fetch runs one bounded GET, detached from the caller's cancellation because other viewers may
// wait on the same flight; the policy's deadline still bounds it.
func (b *Broker) fetch(ctx context.Context, f *safefetch.Fetcher, rawURL, accept string) (*safefetch.Response, error) {
	resp, err := f.Fetch(context.WithoutCancel(ctx), safefetch.Request{
		URL:    rawURL,
		Header: map[string]string{"User-Agent": userAgent, "Accept": accept},
	})
	if err != nil {
		if errors.Is(err, safefetch.ErrBusy) {
			return nil, &Error{Failure: Unavailable, transient: true}
		}
		return nil, fail(classify(err))
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fail(Unavailable)
	}
	return resp, nil
}

// classify maps a safefetch error to the client-visible failure class; the refusal reason stays server-side.
func classify(err error) Failure {
	switch {
	case errors.Is(err, safefetch.ErrTooManyRedirects):
		return TooManyRedirects
	case errors.Is(err, safefetch.ErrBodyTooLarge), errors.Is(err, safefetch.ErrDecompressedTooLarge):
		return Oversized
	case errors.Is(err, safefetch.ErrContentType), errors.Is(err, safefetch.ErrContentEncoding):
		return WrongType
	case errors.Is(err, safefetch.ErrInvalidURL), errors.Is(err, safefetch.ErrBlockedScheme),
		errors.Is(err, safefetch.ErrBlockedPort), errors.Is(err, safefetch.ErrCredentialsInURL),
		errors.Is(err, safefetch.ErrSchemeDowngrade), errors.Is(err, safefetch.ErrHostNotAllowed):
		return BlockedDestination
	case errors.Is(err, safefetch.ErrBlockedAddress):
		// Answered like an unresolvable name: a different answer for "resolves to a private address" would
		// let a member map the server's network by name.
		return Unavailable
	default:
		return Unavailable
	}
}

// reducePage turns a page into preview data: an oEmbed title, or Open Graph fields with the image
// resolved against the page's final URL.
func reducePage(resp *safefetch.Response) (previewData, error) {
	switch resp.ContentType {
	case "application/json":
		data, ok := parseOEmbed(resp.Body)
		if !ok {
			return previewData{}, fail(WrongType)
		}
		return data, nil
	case "text/html", "application/xhtml+xml":
	default:
		return previewData{}, fail(WrongType)
	}
	tags := parseOGTags(resp.Body)
	data := previewData{
		Title:       tags.Title,
		Description: tags.Description,
		SiteName:    tags.SiteName,
		ImageWidth:  tags.ImageWidth,
		ImageHeight: tags.ImageHeight,
	}
	if tags.Image != nil && *tags.Image != "" {
		base, err := url.Parse(resp.FinalURL)
		if err == nil {
			if ref, refErr := base.Parse(*tags.Image); refErr == nil && len(ref.String()) <= maxURLBytes {
				data.ImageURL = ref.String()
			}
		}
	}
	return data, nil
}

// sniffImage is the raster type the bytes are by signature, or "".
func sniffImage(body []byte) string {
	switch {
	case bytes.HasPrefix(body, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(body, []byte{0xff, 0xd8, 0xff}):
		return "image/jpeg"
	case bytes.HasPrefix(body, []byte("GIF87a")), bytes.HasPrefix(body, []byte("GIF89a")):
		return "image/gif"
	case len(body) >= 12 && string(body[:4]) == "RIFF" && string(body[8:12]) == "WEBP":
		return "image/webp"
	case bytes.HasPrefix(body, []byte("BM")):
		return "image/bmp"
	}
	return ""
}
