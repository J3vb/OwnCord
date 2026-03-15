namespace OwnCord.Client.Services;

/// <summary>
/// Trust-On-First-Use (TOFU) certificate pinning service.
/// On the first connection to a host, the certificate fingerprint is automatically
/// trusted and stored. On subsequent connections, the stored fingerprint must match.
/// </summary>
public interface ICertificateTrustService
{
    /// <summary>
    /// Returns true if the given fingerprint is trusted for the host.
    /// On first use (no stored fingerprint), automatically trusts and stores the fingerprint.
    /// Returns false if a different fingerprint was previously stored for this host.
    /// </summary>
    bool IsTrusted(string host, string fingerprint);

    /// <summary>Explicitly stores a fingerprint as trusted for the given host.</summary>
    void TrustFingerprint(string host, string fingerprint);

    /// <summary>Removes any stored trust record for the given host.</summary>
    void RemoveTrust(string host);

    /// <summary>Returns the stored fingerprint for the host, or null if none is stored.</summary>
    string? GetTrustedFingerprint(string host);
}
