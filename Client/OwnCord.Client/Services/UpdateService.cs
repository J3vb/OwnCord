using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using System.Reflection;
using System.Linq;
using System.Collections.Generic;

namespace OwnCord.Client.Services;

public class UpdateService : IUpdateService
{
    private const string GitHubApiUrl = "https://api.github.com/repos/J3vb/OwnCord/releases/latest";
    private const string ValidUrlPrefix = "https://github.com/J3vb/OwnCord/releases/download/";
    private static readonly string SettingsDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OwnCord");
    private static readonly string SettingsPath = Path.Combine(SettingsDir, "update-settings.json");

    private readonly HttpClient _httpClient;
    private UpdateSettings _settings;

    public UpdateService() : this(new HttpClient()) { }

    public UpdateService(HttpClient httpClient)
    {
        _httpClient = httpClient;
        _httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("OwnCord-Client/1.0");
        _settings = LoadSettings();
    }

    public async Task<UpdateInfo?> CheckForUpdateAsync()
    {
        // Check 24-hour cache
        if (_settings.LastCheckUtc.HasValue &&
            DateTime.UtcNow - _settings.LastCheckUtc.Value < TimeSpan.FromHours(24))
        {
            return null;
        }

        try
        {
            var response = await _httpClient.GetAsync(GitHubApiUrl);
            if (!response.IsSuccessStatusCode) return null;

            var release = await response.Content.ReadFromJsonAsync<GitHubRelease>();
            if (release == null) return null;

            var currentVersion = GetCurrentVersion();
            var latestVersion = release.TagName.TrimStart('v');

            // Update cache timestamp
            _settings.LastCheckUtc = DateTime.UtcNow;
            SaveSettings();

            var updateAvailable = CompareVersions(currentVersion, latestVersion) < 0;

            // Check skip list
            if (updateAvailable && _settings.SkippedVersions.Contains(latestVersion))
            {
                return null;
            }

            var downloadUrl = release.Assets?
                .FirstOrDefault(a => a.Name == "OwnCord.Client.exe")?.BrowserDownloadUrl ?? "";
            var checksumUrl = release.Assets?
                .FirstOrDefault(a => a.Name == "checksums.sha256")?.BrowserDownloadUrl ?? "";

            return new UpdateInfo(
                CurrentVersion: currentVersion,
                LatestVersion: latestVersion,
                ReleaseNotes: release.Body ?? "",
                DownloadUrl: downloadUrl,
                ChecksumUrl: checksumUrl,
                UpdateAvailable: updateAvailable
            );
        }
        catch
        {
            return null;
        }
    }

    public async Task DownloadAndVerifyAsync(string downloadUrl, string checksumUrl, string destPath)
    {
        ValidateDownloadUrl(downloadUrl);

        // Download checksum file
        var checksumContent = await _httpClient.GetStringAsync(checksumUrl);
        var expectedHash = ParseChecksumFile(checksumContent, Path.GetFileName(destPath));

        // Download binary
        using var response = await _httpClient.GetAsync(downloadUrl);
        response.EnsureSuccessStatusCode();

        await using var fileStream = File.Create(destPath);
        await response.Content.CopyToAsync(fileStream);
        fileStream.Close();

        // Verify checksum
        var actualHash = ComputeFileHash(destPath);
        if (!string.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase))
        {
            File.Delete(destPath);
            throw new InvalidOperationException(
                $"Checksum mismatch: expected {expectedHash}, got {actualHash}");
        }
    }

    public void ApplyUpdate(string newExePath)
    {
        var currentExe = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName
            ?? throw new InvalidOperationException("Cannot determine current executable path");

        var oldPath = currentExe + ".old";

        // Remove stale .old if present
        if (File.Exists(oldPath)) File.Delete(oldPath);

        // Rename: current -> .old
        File.Move(currentExe, oldPath);

        // Move: new -> current
        File.Move(newExePath, currentExe);

        // Restart
        Process.Start(new ProcessStartInfo
        {
            FileName = currentExe,
            UseShellExecute = true
        });

        Environment.Exit(0);
    }

    public void CleanupOldVersion()
    {
        var currentExe = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName;
        if (currentExe == null) return;

        var oldPath = currentExe + ".old";
        if (File.Exists(oldPath))
        {
            try { File.Delete(oldPath); } catch { /* best effort */ }
        }
    }

    public void SkipVersion(string version)
    {
        if (!_settings.SkippedVersions.Contains(version))
        {
            _settings.SkippedVersions.Add(version);
            SaveSettings();
        }
    }

    private static string GetCurrentVersion()
    {
        var version = Assembly.GetExecutingAssembly().GetName().Version;
        return version != null ? $"{version.Major}.{version.Minor}.{version.Build}" : "0.0.0";
    }

    private static int CompareVersions(string current, string latest)
    {
        if (Version.TryParse(current, out var v1) && Version.TryParse(latest, out var v2))
            return v1.CompareTo(v2);
        return string.Compare(current, latest, StringComparison.Ordinal);
    }

    private static void ValidateDownloadUrl(string url)
    {
        if (!url.StartsWith(ValidUrlPrefix, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException($"Invalid download URL: {url}");
    }

    private static string ParseChecksumFile(string content, string filename)
    {
        foreach (var line in content.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var trimmed = line.Trim();
            var parts = trimmed.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length >= 2 && parts[^1] == filename)
                return parts[0];
        }
        throw new InvalidOperationException($"File '{filename}' not found in checksum data");
    }

    private static string ComputeFileHash(string filePath)
    {
        using var stream = File.OpenRead(filePath);
        var hash = SHA256.HashData(stream);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private UpdateSettings LoadSettings()
    {
        try
        {
            if (File.Exists(SettingsPath))
            {
                var json = File.ReadAllText(SettingsPath);
                return JsonSerializer.Deserialize<UpdateSettings>(json) ?? new UpdateSettings();
            }
        }
        catch { /* ignore corrupt settings */ }
        return new UpdateSettings();
    }

    private void SaveSettings()
    {
        try
        {
            Directory.CreateDirectory(SettingsDir);
            var json = JsonSerializer.Serialize(_settings, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(SettingsPath, json);
        }
        catch { /* best effort */ }
    }
}

internal class UpdateSettings
{
    [JsonPropertyName("last_check_utc")]
    public DateTime? LastCheckUtc { get; set; }

    [JsonPropertyName("skipped_versions")]
    public List<string> SkippedVersions { get; set; } = new();
}

internal class GitHubRelease
{
    [JsonPropertyName("tag_name")]
    public string TagName { get; set; } = "";

    [JsonPropertyName("body")]
    public string? Body { get; set; }

    [JsonPropertyName("html_url")]
    public string HtmlUrl { get; set; } = "";

    [JsonPropertyName("assets")]
    public List<GitHubAsset>? Assets { get; set; }
}

internal class GitHubAsset
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("browser_download_url")]
    public string BrowserDownloadUrl { get; set; } = "";
}
