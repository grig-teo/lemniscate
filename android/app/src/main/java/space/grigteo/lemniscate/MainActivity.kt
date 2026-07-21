package space.grigteo.lemniscate

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import space.grigteo.lemniscate.ui.theme.LemniscateTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            LemniscateTheme {
                AppNav()
            }
        }
    }
}
