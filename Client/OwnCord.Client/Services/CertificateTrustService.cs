using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading;

namespace OwnCord.Client.Services;

/// <summary>
/// Trust-On-First-Use (TOFU) certificate pinning service.
/// Fingerprints are persisted as a JSON file in the application data directory so
/// that trust decisions survive application restarts.
///
/// Storage format: a flat JSON object mapping host strings to SHA-256 hex fingerprints,
/// e.g. { "server.local:8443": "AABBCC..." }
/// </summary>
public sealed class CertificateTrustService : ICertificateTrustService
{
    private readonly string _dir;
    private readonly string _filePath;
    private readonly SemaphoreSlim _lock = new(1, 1);

    // ── Constructors ──────────────────────────────────────────────────────────

    public CertificateTrustService()
        : this(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "OwnCord",
            "certs")) { }

    /// <summary>Internal constructor allowing an isolated directory for unit tests.</summary>
    internal CertificateTrustService(string dir)
    {
        _dir = dir;
        _filePath = Path.Combine(_dir, "trusted_certs.json");
    }

    // ── ICertificateTrustService ──────────────────────────────────────────────

    /// <inheritdoc/>
    public bool IsTrusted(string host, string fingerprint)
    {
        if (string.IsNullOrEmpty(host)) return false;
        if (string.IsNullOrEmpty(fingerprint)) return false;

        _lock.Wait();
        try
        {
            var store = Load();

            if (!store.TryGetValue(host, out var stored))
            {
                // First use — auto-trust (TOFU)
                var updated = new Dictionary<string, string>(store, StringComparer.OrdinalIgnoreCase)
                {
                    [host] = fingerprint
                };
                Save(updated);
                return true;
            }

            return string.Equals(stored, fingerprint, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            _lock.Release();
        }
    }

    /// <inheritdoc/>
    public void TrustFingerprint(string host, string fingerprint)
    {
        if (string.IsNullOrEmpty(host))
            throw new ArgumentException("Host must not be null or empty.", nameof(host));
        if (string.IsNullOrEmpty(fingerprint))
            throw new ArgumentException("Fingerprint must not be null or empty.", nameof(fingerprint));

        _lock.Wait();
        try
        {
            var store = Load();
            var updated = new Dictionary<string, string>(store, StringComparer.OrdinalIgnoreCase)
            {
                [host] = fingerprint
            };
            Save(updated);
        }
        finally
        {
            _lock.Release();
        }
    }

    /// <inheritdoc/>
    public void RemoveTrust(string host)
    {
        if (string.IsNullOrEmpty(host)) return;

        _lock.Wait();
        try
        {
            var store = Load();
            if (!store.ContainsKey(host)) return;

            var updated = new Dictionary<string, string>(store, StringComparer.OrdinalIgnoreCase);
            updated.Remove(host);
            Save(updated);
        }
        finally
        {
            _lock.Release();
        }
    }

    /// <inheritdoc/>
    public string? GetTrustedFingerprint(string host)
    {
        if (string.IsNullOrEmpty(host)) return null;

        var store = Load();
        return store.TryGetValue(host, out var fp) ? fp : null;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true
    };

    /// <summary>
    /// Reads the trust store from disk. Returns an empty dictionary if the file does not exist.
    /// Throws if the file exists but is corrupt/unreadable — this prevents a silent TOFU
    /// downgrade where a corrupt store causes all hosts to be re-auto-trusted.
    /// </summary>
    private Dictionary<string, string> Load()
    {
        if (!File.Exists(_filePath))
            return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        var json = File.ReadAllText(_filePath);
        var raw = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
        return raw is null
            ? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            : new Dictionary<string, string>(raw, StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>Writes the trust store to disk atomically via a temp-file swap.</summary>
    private void Save(Dictionary<string, string> store)
    {
        Directory.CreateDirectory(_dir);

        var json = JsonSerializer.Serialize(store, JsonOpts);

        // Write to a temp file first, then replace, to avoid corruption on crash
        var tmp = _filePath + ".tmp";
        File.WriteAllText(tmp, json);
        File.Move(tmp, _filePath, overwrite: true);
    }
}
