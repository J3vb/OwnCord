using System.Collections.Specialized;
using System.Windows.Controls;
using System.Windows.Input;
using OwnCord.Client.ViewModels;

namespace OwnCord.Client.Views;

public partial class MainPage : Page
{
    private readonly MainViewModel _vm;

    public MainPage(MainViewModel vm)
    {
        InitializeComponent();
        DataContext = vm;
        _vm = vm;
        PreviewKeyDown += OnPreviewKeyDown;

        Loaded += (_, _) =>
        {
            if (vm.DisplayMessages is INotifyCollectionChanged ncc)
                ncc.CollectionChanged += (_, _) => Dispatcher.InvokeAsync(() =>
                    MessagesScrollViewer?.ScrollToEnd(),
                    System.Windows.Threading.DispatcherPriority.Background);
        };
    }

    private void OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Escape) return;

        if (_vm.ShowSettings)
        {
            _vm.ShowSettings = false;
            e.Handled = true;
        }
        else if (_vm.ShowEmojiPicker)
        {
            _vm.ShowEmojiPicker = false;
            e.Handled = true;
        }
        else if (_vm.ShowStatusPicker)
        {
            _vm.ShowStatusPicker = false;
            e.Handled = true;
        }
    }
}
