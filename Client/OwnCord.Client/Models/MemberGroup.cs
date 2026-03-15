using System.Collections.ObjectModel;

namespace OwnCord.Client.Models;

/// <summary>
/// Groups members by their role for the member list sidebar.
/// </summary>
public sealed class MemberGroup
{
    public string RoleName { get; init; } = string.Empty;
    public string? RoleColor { get; init; }
    public int Position { get; init; }
    public ObservableCollection<User> Members { get; } = [];
    public int MemberCount => Members.Count;
}
