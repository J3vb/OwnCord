using System.Net.WebSockets;

namespace OwnCord.Client.Services;

public interface IWebSocketService
{
    bool IsConnected { get; }
    WebSocketState State { get; }

    /// <summary>Fires for each raw JSON message received.</summary>
    event Action<string>? MessageReceived;

    /// <summary>Fires when the connection drops unexpectedly, with a reason string.</summary>
    event Action<string>? Disconnected;

    Task ConnectAsync(string uri, string token, CancellationToken ct = default);
    Task SendAsync(object message, CancellationToken ct = default);

    /// <summary>Starts the receive loop, firing MessageReceived for each message.
    /// Returns when the connection closes.</summary>
    Task RunReceiveLoopAsync(CancellationToken ct);

    IAsyncEnumerable<string> ReceiveAsync(CancellationToken ct);
    Task DisconnectAsync();
}
