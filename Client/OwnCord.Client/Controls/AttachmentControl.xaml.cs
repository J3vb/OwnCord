using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Imaging;

namespace OwnCord.Client.Controls;

public partial class AttachmentControl : UserControl
{
    public static readonly DependencyProperty FilenameProperty =
        DependencyProperty.Register(
            nameof(Filename),
            typeof(string),
            typeof(AttachmentControl),
            new PropertyMetadata(string.Empty, OnPropertyChanged));

    public static readonly DependencyProperty FileSizeProperty =
        DependencyProperty.Register(
            nameof(FileSize),
            typeof(long),
            typeof(AttachmentControl),
            new PropertyMetadata(0L, OnPropertyChanged));

    public static readonly DependencyProperty MimeTypeProperty =
        DependencyProperty.Register(
            nameof(MimeType),
            typeof(string),
            typeof(AttachmentControl),
            new PropertyMetadata(string.Empty, OnPropertyChanged));

    public static readonly DependencyProperty FileUrlProperty =
        DependencyProperty.Register(
            nameof(FileUrl),
            typeof(string),
            typeof(AttachmentControl),
            new PropertyMetadata(string.Empty));

    public string Filename
    {
        get => (string)GetValue(FilenameProperty);
        set => SetValue(FilenameProperty, value);
    }

    public long FileSize
    {
        get => (long)GetValue(FileSizeProperty);
        set => SetValue(FileSizeProperty, value);
    }

    public string MimeType
    {
        get => (string)GetValue(MimeTypeProperty);
        set => SetValue(MimeTypeProperty, value);
    }

    public string FileUrl
    {
        get => (string)GetValue(FileUrlProperty);
        set => SetValue(FileUrlProperty, value);
    }

    public AttachmentControl()
    {
        InitializeComponent();
    }

    private static void OnPropertyChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        if (d is AttachmentControl control)
        {
            control.UpdateDisplay();
        }
    }

    private void UpdateDisplay()
    {
        var isImage = !string.IsNullOrEmpty(MimeType)
                      && MimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase);

        ImagePanel.Visibility = isImage ? Visibility.Visible : Visibility.Collapsed;
        FilePanel.Visibility = isImage ? Visibility.Collapsed : Visibility.Visible;

        if (isImage)
        {
            LoadImage();
        }
        else
        {
            FilenameText.Text = Filename;
            FileSizeText.Text = FormatFileSize(FileSize);
        }
    }

    private void LoadImage()
    {
        if (string.IsNullOrEmpty(FileUrl)) return;

        try
        {
            var bitmap = new BitmapImage();
            bitmap.BeginInit();
            bitmap.UriSource = new Uri(FileUrl, UriKind.RelativeOrAbsolute);
            bitmap.CacheOption = BitmapCacheOption.OnLoad;
            bitmap.DecodePixelWidth = 400; // Limit decode size for performance
            bitmap.EndInit();

            if (bitmap.IsDownloading)
            {
                bitmap.DownloadCompleted += (_, _) =>
                {
                    AttachmentImage.Source = bitmap;
                    ImagePlaceholder.Visibility = Visibility.Collapsed;
                };
                bitmap.DownloadFailed += (_, _) =>
                {
                    // Keep placeholder visible on failure
                };
            }
            else
            {
                AttachmentImage.Source = bitmap;
                ImagePlaceholder.Visibility = Visibility.Collapsed;
            }
        }
        catch
        {
            // Keep placeholder visible on error
        }
    }

    private static string FormatFileSize(long bytes)
    {
        return bytes switch
        {
            < 1024 => $"{bytes} B",
            < 1024 * 1024 => $"{bytes / 1024.0:F1} KB",
            < 1024 * 1024 * 1024 => $"{bytes / (1024.0 * 1024.0):F1} MB",
            _ => $"{bytes / (1024.0 * 1024.0 * 1024.0):F2} GB"
        };
    }
}
