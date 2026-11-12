package com.owncord.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileAudioPolicyTest {
  // android.media.AudioDeviceInfo.TYPE_*
  private val earpiece = 1
  private val speaker = 2
  private val wiredHeadset = 3
  private val wiredHeadphones = 4
  private val bluetoothSco = 7
  private val bluetoothA2dp = 8
  private val hdmi = 9
  private val usbDevice = 11
  private val telephony = 18
  private val usbHeadset = 22
  private val hearingAid = 23
  private val bleHeadset = 26
  private val bleSpeaker = 27

  // android.media.AudioManager.MODE_*
  private val modeNormal = 0
  private val modeRingtone = 1
  private val modeInCall = 2
  private val modeInCommunication = 3
  private val modeCallScreening = 4

  private val phone = setOf("speaker", "earpiece")

  @Test
  fun deviceTypesMapToTheirRoute() {
    assertEquals("speaker", MobileAudioPolicy.kindOf(speaker))
    assertEquals("earpiece", MobileAudioPolicy.kindOf(earpiece))
    for (type in listOf(wiredHeadset, wiredHeadphones, usbHeadset, usbDevice)) {
      assertEquals("wired", MobileAudioPolicy.kindOf(type))
    }
    for (type in listOf(bluetoothSco, bleHeadset, bleSpeaker, hearingAid)) {
      assertEquals("bluetooth", MobileAudioPolicy.kindOf(type))
    }
  }

  @Test
  fun devicesACallDoesNotUseHaveNoRoute() {
    for (type in listOf(bluetoothA2dp, hdmi, telephony, 0, 99)) {
      assertNull(MobileAudioPolicy.kindOf(type))
    }
  }

  @Test
  fun routesComeInTheSheetsOrderWhateverAndroidsOrder() {
    val routes =
      MobileAudioPolicy.routes(
        listOf(bluetoothSco to "Buds", wiredHeadset to "Phone", earpiece to "Phone", speaker to "Phone"),
      )
    assertEquals(listOf("speaker", "earpiece", "wired", "bluetooth"), routes.map { it.kind })
  }

  @Test
  fun onlyABluetoothRouteCarriesItsDeviceName() {
    val routes =
      MobileAudioPolicy.routes(listOf(speaker to "Phone", usbHeadset to "Dongle", bleHeadset to " Buds "))
    assertEquals(
      listOf(AudioRoute("speaker", ""), AudioRoute("wired", ""), AudioRoute("bluetooth", "Buds")),
      routes,
    )
  }

  @Test
  fun theFirstDeviceOfAKindStandsForIt() {
    val routes =
      MobileAudioPolicy.routes(listOf(bluetoothSco to "First", bleHeadset to "Second", hdmi to "TV"))
    assertEquals(listOf(AudioRoute("bluetooth", "First")), routes)
  }

  @Test
  fun aHeadsetIsTheAutomaticRouteElseTheSpeaker() {
    assertEquals("speaker", MobileAudioPolicy.autoKind(phone))
    assertEquals("bluetooth", MobileAudioPolicy.autoKind(phone + "bluetooth"))
    assertEquals("wired", MobileAudioPolicy.autoKind(phone + "bluetooth" + "wired"))
    assertEquals("speaker", MobileAudioPolicy.autoKind(emptySet()))
  }

  @Test
  fun pickingTheAutomaticRouteOrAMissingOneLeavesNoPick() {
    assertNull(MobileAudioPolicy.pick("speaker", phone))
    assertNull(MobileAudioPolicy.pick("bluetooth", phone))
    assertNull(MobileAudioPolicy.pick("bluetooth", phone + "bluetooth"))
    assertNull(MobileAudioPolicy.pick("nonsense", phone))
  }

  @Test
  fun pickingAnotherRouteKeepsIt() {
    assertEquals("earpiece", MobileAudioPolicy.pick("earpiece", phone))
    assertEquals("speaker", MobileAudioPolicy.pick("speaker", phone + "bluetooth"))
    assertEquals("bluetooth", MobileAudioPolicy.pick("bluetooth", phone + "bluetooth" + "wired"))
  }

  @Test
  fun aPickStaysWhileNothingRelevantChanges() {
    assertEquals("earpiece", MobileAudioPolicy.manualAfterChange("earpiece", phone, phone))
    assertEquals(
      "earpiece",
      MobileAudioPolicy.manualAfterChange("earpiece", phone + "bluetooth", phone),
    )
    assertNull(MobileAudioPolicy.manualAfterChange(null, phone, phone + "bluetooth"))
  }

  @Test
  fun aPickGoesWhenItsDeviceLeaves() {
    val withBoth = phone + "bluetooth" + "wired"
    assertNull(MobileAudioPolicy.manualAfterChange("bluetooth", withBoth, phone + "wired"))
  }

  @Test
  fun aNewHeadsetTakesOverFromAPick() {
    assertNull(MobileAudioPolicy.manualAfterChange("earpiece", phone, phone + "bluetooth"))
    assertNull(
      MobileAudioPolicy.manualAfterChange("speaker", phone + "bluetooth", phone + "bluetooth" + "wired"),
    )
  }

  @Test
  fun aPickThatBecameTheAutomaticRouteIsDropped() {
    assertNull(MobileAudioPolicy.manualAfterChange("speaker", phone + "bluetooth", phone))
  }

  @Test
  fun onlyAnAnsweredPhoneCallInterrupts() {
    assertTrue(MobileAudioPolicy.interrupts(modeInCall))
    for (mode in listOf(modeNormal, modeRingtone, modeInCommunication, modeCallScreening)) {
      assertFalse(MobileAudioPolicy.interrupts(mode))
    }
  }

  @Test
  fun aDeviceIsAskedForOnlyInTheAppsOwnCallMode() {
    assertTrue(MobileAudioPolicy.mayRequest(modeInCommunication))
    for (mode in listOf(modeNormal, modeRingtone, modeInCall, modeCallScreening)) {
      assertFalse(MobileAudioPolicy.mayRequest(mode))
    }
  }

  @Test
  fun theShownRouteIsWhatAndroidReportsInCallMode() {
    assertEquals("speaker", MobileAudioPolicy.active("earpiece", speaker, phone))
    assertEquals("bluetooth", MobileAudioPolicy.active(null, bleHeadset, phone + "bluetooth"))
  }

  @Test
  fun theShownRouteFallsBackToThePickThenTheAutomaticRoute() {
    assertEquals("earpiece", MobileAudioPolicy.active("earpiece", null, phone))
    assertEquals("earpiece", MobileAudioPolicy.active("earpiece", hdmi, phone))
    assertEquals("speaker", MobileAudioPolicy.active(null, null, phone))
    assertEquals("wired", MobileAudioPolicy.active(null, null, phone + "wired"))
  }

  @Test
  fun theBudgetRefusesOnceItIsSpentAndRefillsAsTimePasses() {
    val budget = MobileAudioPolicy.Budget(max = 3, windowMs = 1_000)
    assertTrue(budget.take(0))
    assertTrue(budget.take(100))
    assertTrue(budget.take(200))
    assertFalse(budget.take(999))
    assertTrue(budget.take(1_000))
    assertFalse(budget.take(1_050))
  }

  @Test
  fun aResetBudgetStartsOver() {
    val budget = MobileAudioPolicy.Budget(max = 1, windowMs = 1_000)
    assertTrue(budget.take(0))
    assertFalse(budget.take(1))
    budget.reset()
    assertTrue(budget.take(2))
  }
}
