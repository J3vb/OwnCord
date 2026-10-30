package admin

func init() {
	// Id and role mention resolution.
	supportEventCodes["MessageService.resolveMentions GetReachableUserIDs"] = "messageservice_resolvementions_getreachableuserids"
	supportEventCodes["MessageService.resolveMentions ListRoles"] = "messageservice_resolvementions_listroles"
	supportEventCodes["MessageService.resolveMentions Subject"] = "messageservice_resolvementions_subject"
	supportEventCodes["MessageService.resolveMentions ListUserIDsByRoles"] = "messageservice_resolvementions_listuseridsbyroles"
}
