namespace OwnCord.Client.Services;

public interface IWebSocketService
{
    bool IsConnected { get; }
    Task ConnectAsync(string uri, string token, CancellationToken ct = default);
    Task SendAsync(object message, CancellationToken ct = default);
    IAsyncEnumerable<string> ReceiveAsync(CancellationToken ct);
    Task DisconnectAsync();
}
