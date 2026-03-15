namespace OwnCord.Client.Services;

public sealed class ToastService
{
    public string? CurrentMessage { get; private set; }
    public bool IsVisible { get; private set; }

    public event Action? ToastChanged;

    public void Show(string message)
    {
        CurrentMessage = message;
        IsVisible = true;
        ToastChanged?.Invoke();
    }

    public void Hide()
    {
        IsVisible = false;
        ToastChanged?.Invoke();
    }
}
