using System.IO;
using OwnCord.Client.Services;

namespace OwnCord.Client.Tests.Services;

/// <summary>
/// Tests for CertificateTrustService — Trust-On-First-Use (TOFU) certificate pinning.
/// Each test uses an isolated temp directory so there is no shared state between tests.
/// </summary>
public sealed class CertificateTrustServiceTests : IDisposable
{
    private readonly string _tempDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());

    // Factory so each assertion that needs a "new instance" can create one pointing at the same dir.
    private CertificateTrustService NewSvc() => new(_tempDir);

    // ── IsTrusted ─────────────────────────────────────────────────────────────

    [Fact]
    public void IsTrusted_FirstUse_AutoTrustsAndReturnsTrue()
    {
        // Arrange: no stored fingerprint for this host
        var svc = NewSvc();

        // Act: first connection — TOFU should auto-trust
        var result = svc.IsTrusted("server1.local:8443", "AABBCC112233");

        // Assert
        Assert.True(result, "First-use should auto-trust the certificate and return true.");
    }

    [Fact]
    public void IsTrusted_SameFingerprint_ReturnsTrue()
    {
        // Arrange: trust fingerprint on first use
        var svc = NewSvc();
        svc.IsTrusted("server2.local:8443", "FINGERPRINT_A");

        // Act: same fingerprint presented again
        var result = svc.IsTrusted("server2.local:8443", "FINGERPRINT_A");

        Assert.True(result, "A previously trusted fingerprint must continue to be accepted.");
    }

    [Fact]
    public void IsTrusted_DifferentFingerprint_ReturnsFalse()
    {
        // Arrange: trust an initial fingerprint
        var svc = NewSvc();
        svc.IsTrusted("server3.local:8443", "FINGERPRINT_ORIGINAL");

        // Act: different fingerprint — cert was swapped
        var result = svc.IsTrusted("server3.local:8443", "FINGERPRINT_ATTACKER");

        Assert.False(result, "A changed fingerprint must be rejected to prevent MITM.");
    }

    [Fact]
    public void IsTrusted_NullCertificate_ReturnsFalse()
    {
        // Arrange: host has an existing trusted fingerprint
        var svc = NewSvc();
        svc.TrustFingerprint("server4.local:8443", "FINGERPRINT_OK");

        // Act: null/empty fingerprint (cert was null)
        var resultNull = svc.IsTrusted("server4.local:8443", null!);
        var resultEmpty = svc.IsTrusted("server4.local:8443", "");

        Assert.False(resultNull, "Null fingerprint must be rejected.");
        Assert.False(resultEmpty, "Empty fingerprint must be rejected.");
    }

    [Fact]
    public void IsTrusted_NullOrEmptyHost_ReturnsFalse()
    {
        var svc = NewSvc();

        Assert.False(svc.IsTrusted(null!, "FINGERPRINT"), "Null host must return false.");
        Assert.False(svc.IsTrusted("", "FINGERPRINT"), "Empty host must return false.");
    }

    [Fact]
    public void IsTrusted_DifferentHostsSameFingerprint_TrackedIndependently()
    {
        // Two different hosts can have the same fingerprint — each is independent
        var svc = NewSvc();
        svc.IsTrusted("host-a:8443", "SHARED_FINGERPRINT");
        svc.IsTrusted("host-b:8443", "SHARED_FINGERPRINT");

        // Changing one host's cert must not affect the other
        Assert.True(svc.IsTrusted("host-a:8443", "SHARED_FINGERPRINT"));
        Assert.True(svc.IsTrusted("host-b:8443", "SHARED_FINGERPRINT"));
        Assert.False(svc.IsTrusted("host-a:8443", "NEW_FINGERPRINT"));
        Assert.True(svc.IsTrusted("host-b:8443", "SHARED_FINGERPRINT"), "host-b trust must be unaffected.");
    }

    // ── TrustFingerprint ──────────────────────────────────────────────────────

    [Fact]
    public void TrustFingerprint_StoresFingerprint_CanBeRetrieved()
    {
        var svc = NewSvc();
        svc.TrustFingerprint("server5.local:8443", "STORED_FP");

        Assert.Equal("STORED_FP", svc.GetTrustedFingerprint("server5.local:8443"));
    }

    [Fact]
    public void TrustFingerprint_OverwritesExisting()
    {
        // Explicitly overwriting — e.g. user manually updated cert trust
        var svc = NewSvc();
        svc.TrustFingerprint("server6.local:8443", "OLD_FP");
        svc.TrustFingerprint("server6.local:8443", "NEW_FP");

        Assert.Equal("NEW_FP", svc.GetTrustedFingerprint("server6.local:8443"));
    }

    // ── RemoveTrust ───────────────────────────────────────────────────────────

    [Fact]
    public void RemoveTrust_RemovesStoredFingerprint()
    {
        var svc = NewSvc();
        svc.TrustFingerprint("server7.local:8443", "FP");
        svc.RemoveTrust("server7.local:8443");

        Assert.Null(svc.GetTrustedFingerprint("server7.local:8443"));
    }

    [Fact]
    public void RemoveTrust_AfterRemoval_NextConnectionAutoTrustsAgain()
    {
        // After trust is cleared, the next connection acts as first-use again
        var svc = NewSvc();
        svc.TrustFingerprint("server8.local:8443", "OLD_FP");
        svc.RemoveTrust("server8.local:8443");

        var result = svc.IsTrusted("server8.local:8443", "NEW_FP");

        Assert.True(result, "After removing trust, the next fingerprint should be auto-trusted.");
        Assert.Equal("NEW_FP", svc.GetTrustedFingerprint("server8.local:8443"));
    }

    [Fact]
    public void RemoveTrust_NonExistentHost_DoesNotThrow()
    {
        var svc = NewSvc();
        var ex = Record.Exception(() => svc.RemoveTrust("never-seen.local:8443"));
        Assert.Null(ex);
    }

    // ── GetTrustedFingerprint ─────────────────────────────────────────────────

    [Fact]
    public void GetTrustedFingerprint_UnknownHost_ReturnsNull()
    {
        var svc = NewSvc();
        Assert.Null(svc.GetTrustedFingerprint("unknown.local:8443"));
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    [Fact]
    public void Persistence_FingerprintSurvivesNewInstanceCreation()
    {
        // Instance 1: store a fingerprint
        NewSvc().TrustFingerprint("persist-host:8443", "PERSISTED_FP");

        // Instance 2: different object, same directory — must read the stored fingerprint
        var fp = NewSvc().GetTrustedFingerprint("persist-host:8443");
        Assert.Equal("PERSISTED_FP", fp);
    }

    [Fact]
    public void Persistence_IsTrustedUsesPersistedData()
    {
        // First process: trust on first use
        NewSvc().IsTrusted("persist2-host:8443", "FIRST_FP");

        // Second process: different instance must reject a changed fingerprint
        var result = NewSvc().IsTrusted("persist2-host:8443", "CHANGED_FP");
        Assert.False(result, "Persisted fingerprint must be enforced across instances.");
    }

    [Fact]
    public void Persistence_RemoveTrustSurvivesNewInstance()
    {
        var svc1 = NewSvc();
        svc1.TrustFingerprint("persist3-host:8443", "FP");
        svc1.RemoveTrust("persist3-host:8443");

        // New instance: trust should be gone
        Assert.Null(NewSvc().GetTrustedFingerprint("persist3-host:8443"));
    }

    [Fact]
    public void Persistence_CreatesDirectoryIfMissing()
    {
        Assert.False(Directory.Exists(_tempDir));
        NewSvc().TrustFingerprint("server-dir-test:8443", "FP");
        Assert.True(Directory.Exists(_tempDir));
    }

    // ── Fingerprint case-insensitivity ────────────────────────────────────────

    [Fact]
    public void IsTrusted_FingerprintComparison_IsCaseInsensitive()
    {
        // SHA-256 hex strings may arrive in upper or lower case depending on the source
        var svc = NewSvc();
        svc.TrustFingerprint("case-host:8443", "aabbccddeeff");

        Assert.True(svc.IsTrusted("case-host:8443", "AABBCCDDEEFF"),
            "Fingerprint comparison must be case-insensitive.");
        Assert.True(svc.IsTrusted("case-host:8443", "aAbBcCdDeEfF"),
            "Mixed-case fingerprint must also match.");
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDir))
            Directory.Delete(_tempDir, recursive: true);
    }
}
