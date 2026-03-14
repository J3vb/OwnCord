namespace OwnCord.Client.Services;

public interface ICredentialService
{
    void SaveToken(string host, string username, string token);
    string? LoadToken(string host, string username);
    void DeleteToken(string host, string username);

    void SavePassword(string host, string username, string password);
    string? LoadPassword(string host, string username);
    void DeletePassword(string host, string username);
}
