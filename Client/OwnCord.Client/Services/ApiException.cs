namespace OwnCord.Client.Services;

/// <summary>
/// Exception thrown when the OwnCord server returns an error response.
/// </summary>
public sealed class ApiException : Exception
{
    public string ErrorCode { get; }
    public int StatusCode { get; }

    public ApiException(string errorCode, string message, int statusCode)
        : base(message)
    {
        ErrorCode = errorCode;
        StatusCode = statusCode;
    }
}
