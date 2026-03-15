using System.Threading;

namespace OwnCord.Client.Services;

/// <summary>
/// Async-aware ambient context that carries the current server host into the
/// <see cref="System.Net.Http.HttpClientHandler.ServerCertificateCustomValidationCallback"/>.
///
/// Uses <see cref="AsyncLocal{T}"/> instead of [ThreadStatic] so the value flows
/// correctly through async continuations and thread-pool threads used by HttpClient.
/// </summary>
internal static class TofuHostContext
{
    private static readonly AsyncLocal<string?> _currentHost = new();

    /// <summary>Gets or sets the host (host:port) for the in-progress request in this async flow.</summary>
    internal static string? CurrentHost
    {
        get => _currentHost.Value;
        set => _currentHost.Value = value;
    }
}
