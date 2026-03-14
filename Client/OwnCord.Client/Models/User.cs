namespace OwnCord.Client.Models;

public enum UserStatus { Online, Idle, Dnd, Offline }

public record User(
    long Id,
    string Username,
    string? Avatar,
    long RoleId,
    UserStatus Status
);
