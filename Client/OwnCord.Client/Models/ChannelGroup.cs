using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace OwnCord.Client.Models;

/// <summary>
/// Groups channels by category for the sidebar. Supports collapse/expand.
/// </summary>
public sealed class ChannelGroup : INotifyPropertyChanged
{
    private bool _isExpanded = true;

    public string? CategoryName { get; init; }
    public ObservableCollection<ChannelItem> Items { get; } = [];

    public bool IsExpanded
    {
        get => _isExpanded;
        set { if (_isExpanded != value) { _isExpanded = value; OnPropertyChanged(); } }
    }

    /// <summary>Display name: uppercase category or empty for ungrouped.</summary>
    public string DisplayName => CategoryName?.ToUpperInvariant() ?? string.Empty;

    /// <summary>True if this group has a category name (shows header).</summary>
    public bool HasCategory => CategoryName is not null;

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
