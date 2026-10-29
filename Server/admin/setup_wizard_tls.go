package admin

import (
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/config"
)

// errWizardAcmePort80 mirrors guardAcmeTLS's refusal for the same choice from
// the panel.
var errWizardAcmePort80 = errors.New("port must not be 80 when tls_mode is acme; the HTTPS listener would occupy the port the ACME challenge needs")

// wizardTLSRefusal runs the panel's TLS guards on the wizard's choice, so a
// setting the next boot cannot serve is refused before the owner account is
// created. The wizard cannot set the certificate paths, so a manual pair is
// judged at the running tls.cert_file and tls.key_file. A nil running config
// (the direct-construction test path) has nothing to judge against.
func wizardTLSRefusal(wr *setupWizardRequest, running *config.Config) error {
	if wr == nil || running == nil || (wr.TLSMode == nil && wr.Port == nil) {
		return nil
	}
	mode, port := running.TLS.Mode, running.Server.Port
	if wr.TLSMode != nil {
		mode = *wr.TLSMode
	}
	if wr.Port != nil {
		port = *wr.Port
	}
	if mode == "acme" && port == 80 {
		return errWizardAcmePort80
	}
	if mode == "manual" && wr.TLSMode != nil {
		if err := manualTLSPairError(running.TLS.CertFile, running.TLS.KeyFile); err != nil {
			return fmt.Errorf("tls_mode manual needs a certificate pair in config.yaml: %w", err)
		}
	}
	return nil
}
