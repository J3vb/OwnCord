using System.Threading.Tasks;

namespace OwnCord.Client.Services;

public record UpdateInfo(
    string CurrentVersion,
    string LatestVersion,
    string ReleaseNotes,
    string DownloadUrl,
    string ChecksumUrl,
    bool UpdateAvailable
);

public interface IUpdateService
{
    Task<UpdateInfo?> CheckForUpdateAsync();
    Task DownloadAndVerifyAsync(string downloadUrl, string checksumUrl, string destPath);
    void ApplyUpdate(string newExePath);
    void CleanupOldVersion();
    void SkipVersion(string version);
}
