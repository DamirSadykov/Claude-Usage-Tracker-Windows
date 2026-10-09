namespace Shop.Sms
{
    public class Notifier
    {
        private readonly ISmsClient _client;
        private readonly ICustomerRepo _repo;

        public Notifier(ISmsClient client, ICustomerRepo repo)
        {
            _client = client;
            _repo = repo;
        }

        public void SendSms(int customerId, string text)
        {
            var phone = "79990000000";
            if (!ValidatePhone(phone)) return;
            _client.Send(phone, text);
        }

        private string GetPhone(int customerId)
        {
            return _repo.Get(customerId).Phone;
        }

        private bool ValidatePhone(string phone)
        {
            return phone != null && phone.Length == 11;
        }
    }
}
