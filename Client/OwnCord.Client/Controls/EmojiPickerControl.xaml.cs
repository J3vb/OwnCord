using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using OwnCord.Client.Services;

namespace OwnCord.Client.Controls;

public partial class EmojiPickerControl : UserControl
{
    public static readonly DependencyProperty EmojiSelectedCommandProperty =
        DependencyProperty.Register(
            nameof(EmojiSelectedCommand),
            typeof(ICommand),
            typeof(EmojiPickerControl),
            new PropertyMetadata(null));

    public static readonly DependencyProperty SearchTextProperty =
        DependencyProperty.Register(
            nameof(SearchText),
            typeof(string),
            typeof(EmojiPickerControl),
            new PropertyMetadata(string.Empty, OnSearchTextChanged));

    public EmojiPickerControl()
    {
        InitializeComponent();
        RefreshCategories();
    }

    public ICommand EmojiSelectedCommand
    {
        get => (ICommand)GetValue(EmojiSelectedCommandProperty);
        set => SetValue(EmojiSelectedCommandProperty, value);
    }

    public string SearchText
    {
        get => (string)GetValue(SearchTextProperty);
        set => SetValue(SearchTextProperty, value);
    }

    private static void OnSearchTextChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        if (d is EmojiPickerControl picker)
            picker.RefreshCategories();
    }

    private void RefreshCategories()
    {
        var query = SearchText?.Trim() ?? string.Empty;

        if (string.IsNullOrEmpty(query))
        {
            CategoryList.ItemsSource = EmojiData.Categories;
            return;
        }

        var filtered = EmojiData.Categories
            .Where(c => c.Name.Contains(query, StringComparison.OrdinalIgnoreCase))
            .ToList();

        CategoryList.ItemsSource = filtered.Count > 0
            ? filtered
            : EmojiData.Categories;
    }
}
