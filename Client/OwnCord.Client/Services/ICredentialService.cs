namespace OwnCord.Client.Services;

public interface ICredentialService
{
    void SaveToken(string host, string username, string token);
    string? LoadToken(string host, string username);
    void DeleteToken(string host, string username);
}
