using System.IO;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OwnCord.Client.Services;

public sealed class WebSocketService : IWebSocketService, IDisposable
{
    private readonly ICertificateTrustService _trustService;
    private ClientWebSocket? _ws;

    public WebSocketService(ICertificateTrustService trustService)
    {
        _trustService = trustService;
    }

    public bool IsConnected => _ws?.State == WebSocketState.Open;
    public WebSocketState State => _ws?.State ?? WebSocketState.None;

    public event Action<string>? MessageReceived;
    public event Action? Disconnected;

    public async Task ConnectAsync(string uri, string token, CancellationToken ct = default)
    {
        _ws?.Dispose();
        _ws = new ClientWebSocket();

        var host = ExtractHost(uri);

        // Trust-On-First-Use (TOFU) certificate pinning.
        // On first connection to a host, the certificate SHA-256 fingerprint is stored.
        // On subsequent connections, the fingerprint must match the stored value.
        _ws.Options.RemoteCertificateValidationCallback = (_, cert, _, _) =>
        {
            if (cert == null) return false;
            var fingerprint = cert.GetCertHashString(HashAlgorithmName.SHA256);
            return _trustService.IsTrusted(host, fingerprint);
        };

        await _ws.ConnectAsync(new Uri(uri), ct);
        var auth = JsonSerializer.Serialize(new { type = "auth", payload = new { token } });
        await SendRawAsync(auth, ct);
    }

    public async Task SendAsync(object message, CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(message);
        await SendRawAsync(json, ct);
    }

    public async Task RunReceiveLoopAsync(CancellationToken ct)
    {
        if (_ws is null) return;
        var buf = new byte[8192];

        try
        {
            while (_ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                using var ms = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await _ws.ReceiveAsync(buf, ct);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        Disconnected?.Invoke();
                        return;
                    }
                    ms.Write(buf, 0, result.Count);
                } while (!result.EndOfMessage);

                var text = Encoding.UTF8.GetString(ms.ToArray());
                MessageReceived?.Invoke(text);
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown via cancellation.
        }
        catch (WebSocketException)
        {
            Disconnected?.Invoke();
        }
    }

    public async IAsyncEnumerable<string> ReceiveAsync([EnumeratorCancellation] CancellationToken ct)
    {
        if (_ws is null) yield break;
        var buf = new byte[8192];
        while (_ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            using var ms = new MemoryStream();
            WebSocketReceiveResult result;
            do
            {
                result = await _ws.ReceiveAsync(buf, ct);
                if (result.MessageType == WebSocketMessageType.Close) yield break;
                ms.Write(buf, 0, result.Count);
            } while (!result.EndOfMessage);
            yield return Encoding.UTF8.GetString(ms.ToArray());
        }
    }

    public async Task DisconnectAsync()
    {
        if (_ws?.State == WebSocketState.Open)
            await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Disconnect", default);
    }

    /// <summary>
    /// Extracts "host:port" from a WebSocket URI for use as the trust store key.
    /// e.g. "wss://server.local:8443/ws" → "server.local:8443"
    /// </summary>
    private static string ExtractHost(string uri)
    {
        try
        {
            var u = new Uri(uri);
            return u.IsDefaultPort ? u.Host : $"{u.Host}:{u.Port}";
        }
        catch
        {
            return uri;
        }
    }

    private async Task SendRawAsync(string text, CancellationToken ct)
    {
        if (_ws is null) return;
        var bytes = Encoding.UTF8.GetBytes(text);
        await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
    }

    public void Dispose() => _ws?.Dispose();
}
