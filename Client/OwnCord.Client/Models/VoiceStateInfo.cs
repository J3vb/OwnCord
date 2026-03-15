using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace OwnCord.Client.Models;

/// <summary>
/// Mutable view-model-friendly class representing a user's voice state.
/// Implements INotifyPropertyChanged so the UI can bind to Speaking, Muted, etc.
/// </summary>
public sealed class VoiceStateInfo : INotifyPropertyChanged
{
    private bool _muted;
    private bool _deafened;
    private bool _speaking;
    private long _channelId;

    public long UserId { get; init; }
    public long ChannelId
    {
        get => _channelId;
        set { if (_channelId != value) { _channelId = value; OnPropertyChanged(); } }
    }
    public string Username { get; init; } = string.Empty;

    public bool Muted
    {
        get => _muted;
        set { if (_muted != value) { _muted = value; OnPropertyChanged(); } }
    }

    public bool Deafened
    {
        get => _deafened;
        set { if (_deafened != value) { _deafened = value; OnPropertyChanged(); } }
    }

    public bool Speaking
    {
        get => _speaking;
        set { if (_speaking != value) { _speaking = value; OnPropertyChanged(); } }
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
