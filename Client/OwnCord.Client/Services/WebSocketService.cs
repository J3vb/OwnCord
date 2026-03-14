using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;

namespace OwnCord.Client.Services;

public sealed class WebSocketService : IWebSocketService, IDisposable
{
    private ClientWebSocket? _ws;

    public bool IsConnected => _ws?.State == WebSocketState.Open;

    public async Task ConnectAsync(string uri, string token, CancellationToken ct = default)
    {
        _ws = new ClientWebSocket();
        await _ws.ConnectAsync(new Uri(uri), ct);
        var auth = JsonSerializer.Serialize(new { type = "auth", payload = new { token } });
        await SendRawAsync(auth, ct);
    }

    public async Task SendAsync(object message, CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(message);
        await SendRawAsync(json, ct);
    }

    public async IAsyncEnumerable<string> ReceiveAsync([EnumeratorCancellation] CancellationToken ct)
    {
        if (_ws is null) yield break;
        var buf = new byte[8192];
        while (_ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            using var ms = new System.IO.MemoryStream();
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

    private async Task SendRawAsync(string text, CancellationToken ct)
    {
        if (_ws is null) return;
        var bytes = Encoding.UTF8.GetBytes(text);
        await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
    }

    public void Dispose() => _ws?.Dispose();
}
