trait Notifier { fn send_sms(&self, text:&str)->Result<(),()> { self.send(text); Ok(()) } fn send(&self,_:&str) {} }
