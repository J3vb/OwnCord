using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OwnCord.Client.Services;

/// <summary>
/// Stores auth tokens encrypted with DPAPI (CurrentUser scope) in AppData.
/// Equivalent security to Windows Credential Manager without requiring WinRT.
/// </summary>
public sealed class CredentialService : ICredentialService
{
    private readonly string _dir;

    public CredentialService()
        : this(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "OwnCord", "creds")) { }

    internal CredentialService(string dir) => _dir = dir;

    public void SaveToken(string host, string username, string token)
    {
        Directory.CreateDirectory(_dir);
        var plain = Encoding.UTF8.GetBytes(token);
        var encrypted = ProtectedData.Protect(plain, GetEntropy(host, username), DataProtectionScope.CurrentUser);
        File.WriteAllBytes(CredPath(host, username), encrypted);
    }

    public string? LoadToken(string host, string username)
    {
        var path = CredPath(host, username);
        if (!File.Exists(path)) return null;
        try
        {
            var encrypted = File.ReadAllBytes(path);
            var plain = ProtectedData.Unprotect(encrypted, GetEntropy(host, username), DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(plain);
        }
        catch { return null; }
    }

    public void DeleteToken(string host, string username)
    {
        var path = CredPath(host, username);
        if (File.Exists(path)) File.Delete(path);
    }

    private string CredPath(string host, string username)
    {
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{host}:{username}")));
        return Path.Combine(_dir, key + ".dat");
    }

    private static byte[] GetEntropy(string host, string username)
        => Encoding.UTF8.GetBytes($"owncord:{host}:{username}");
}
